/**
 * E2E: recovery QR race reproduction + fixed issuance against local API.
 * Run: node --experimental-strip-types /workspace/scripts/test-recovery-race.mjs
 * (plain mjs with webcrypto — no TS)
 */
import { webcrypto } from 'node:crypto';

const crypto = webcrypto;
const API = 'http://127.0.0.1:3001/api';

const ALGO = { name: 'ECDH', namedCurve: 'P-256' };
const SIGN_ALGO = { name: 'ECDSA', namedCurve: 'P-256' };

function bytesToB64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
function bufToB64(buf) {
  return bytesToB64(new Uint8Array(buf));
}
function b64ToBuf(b64) {
  return Buffer.from(b64, 'base64');
}

async function generateKeyPair() {
  return crypto.subtle.generateKey(ALGO, true, ['deriveKey', 'deriveBits']);
}
async function generateSigningKeyPair() {
  return crypto.subtle.generateKey(SIGN_ALGO, true, ['sign', 'verify']);
}
async function exportPublicKey(key) {
  return bufToB64(await crypto.subtle.exportKey('raw', key));
}
async function exportPrivateKey(key) {
  return bufToB64(await crypto.subtle.exportKey('pkcs8', key));
}
async function exportSigningPublicKey(key) {
  return bufToB64(await crypto.subtle.exportKey('spki', key));
}
async function exportSigningPrivateKey(key) {
  return bufToB64(await crypto.subtle.exportKey('pkcs8', key));
}
async function signNonce(privateKey, nonceB64) {
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    b64ToBuf(nonceB64),
  );
  return bufToB64(sig);
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || data.message || text || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function makeIdentity(label) {
  const ecdh = await generateKeyPair();
  const sign = await generateSigningKeyPair();
  return {
    label,
    ecdh,
    sign,
    publicKey: await exportPublicKey(ecdh.publicKey),
    privateKey: await exportPrivateKey(ecdh.privateKey),
    signingPublicKey: await exportSigningPublicKey(sign.publicKey),
    signingPrivateKey: await exportSigningPrivateKey(sign.privateKey),
  };
}

async function login(identity, username) {
  const { nonce } = await api('/auth/challenge', { method: 'POST', body: { username } });
  const signature = await signNonce(identity.sign.privateKey, nonce);
  const { token, user } = await api('/auth/verify', {
    method: 'POST',
    body: { username, signature },
  });
  return { token, user };
}

function bytesToB64Url(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function wrapRecoveryBundle(bundle) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const aesKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(bundle));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded);
  return {
    ciphertext: JSON.stringify({
      v: 1,
      ciphertext: bufToB64(cipher),
      iv: bytesToB64(iv),
    }),
    keyB64Url: bytesToB64Url(raw),
  };
}

async function main() {
  const setup = await api('/auth/setup-status');
  console.log('setup', setup);
  if (!setup.needsBootstrap) {
    console.log('DB already has users — wipe server/data and restart for a clean run');
    process.exit(2);
  }

  const admin = await makeIdentity('admin');
  const adminUser = await api('/auth/register', {
    method: 'POST',
    body: {
      username: 'Admin',
      publicKey: admin.publicKey,
      signingPublicKey: admin.signingPublicKey,
      bootstrapToken: 'dev-bootstrap-token',
    },
  });
  console.log('admin registered', adminUser.id);
  const { token: adminJwt } = await login(admin, 'Admin');

  const { token: inviteToken } = await api('/invites', {
    method: 'POST',
    token: adminJwt,
    body: { username: 'Bob Test' },
  });
  console.log('invite', inviteToken.slice(0, 8) + '…');

  const bob = await makeIdentity('bob');
  const bobUser = await api('/auth/register', {
    method: 'POST',
    body: {
      username: 'Bob Test',
      publicKey: bob.publicKey,
      signingPublicKey: bob.signingPublicKey,
      inviteToken,
    },
  });
  console.log('bob registered', bobUser.id);
  const { token: bobJwt } = await login(bob, 'Bob Test');

  // Minimal escrow ciphertext (opaque to server)
  await api('/users/me/key-backup', {
    method: 'PUT',
    token: bobJwt,
    body: { ciphertext: 'escrow-for-bob' },
  });

  // --- Reproduce the Strict Mode race (unguarded double create) ---
  const wrapA = await wrapRecoveryBundle({
    v: 1,
    privateKey: bob.privateKey,
    signingPrivateKey: bob.signingPrivateKey,
    signingPublicKey: bob.signingPublicKey,
  });
  const wrapB = await wrapRecoveryBundle({
    v: 1,
    privateKey: bob.privateKey,
    signingPrivateKey: bob.signingPrivateKey,
    signingPublicKey: bob.signingPublicKey,
  });

  // Slow first create + fast second, then late first overwrites (classic race)
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  let shownToken;
  const pShown = (async () => {
    await delay(30);
    const session = await api(`/admin/users/${bobUser.id}/recovery`, {
      method: 'POST',
      token: adminJwt,
      body: { ciphertext: wrapB.ciphertext },
    });
    shownToken = session.token;
    return session;
  })();
  const pLate = (async () => {
    // Start first "effect" create that finishes AFTER the shown one
    await delay(80);
    return api(`/admin/users/${bobUser.id}/recovery`, {
      method: 'POST',
      token: adminJwt,
      body: { ciphertext: wrapA.ciphertext },
    });
  })();

  const [shown, late] = await Promise.all([pShown, pLate]);
  console.log('race: shown token', shown.token.slice(0, 10), 'late token', late.token.slice(0, 10));

  let peekShown;
  try {
    peekShown = await api(`/auth/recovery?token=${encodeURIComponent(shown.token)}`);
  } catch (e) {
    peekShown = { error: e.message, status: e.status };
  }
  console.log('peek of UI-shown token after race:', peekShown);

  if (!peekShown.error) {
    console.error('FAIL: expected shown token to be invalid after unguarded race');
    process.exit(1);
  }
  console.log('OK: reproduced bug — shown link is invalid after late create');

  // --- Fixed path: serialize + stale guard (same as client helper) ---
  let gen = 0;
  const queue = (() => {
    let tail = Promise.resolve();
    return (task) => {
      const run = tail.then(task, task);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };
  })();

  async function issueGuarded() {
    const myGen = ++gen;
    const isStale = () => myGen !== gen;
    return queue(async () => {
      if (isStale()) return null;
      const wrapped = await wrapRecoveryBundle({
        v: 1,
        privateKey: bob.privateKey,
        signingPrivateKey: bob.signingPrivateKey,
        signingPublicKey: bob.signingPublicKey,
      });
      if (isStale()) return null;
      const session = await api(`/admin/users/${bobUser.id}/recovery`, {
        method: 'POST',
        token: adminJwt,
        body: { ciphertext: wrapped.ciphertext },
      });
      if (isStale()) return null;
      return { token: session.token, key: wrapped.keyB64Url };
    });
  }

  const [a, b] = await Promise.all([issueGuarded(), issueGuarded()]);
  console.log('guarded double-issue:', { a: a && a.token.slice(0, 10), b: b && b.token.slice(0, 10) });
  if (a !== null || !b) {
    console.error('FAIL: expected first stale null and second result');
    process.exit(1);
  }
  const peekOk = await api(`/auth/recovery?token=${encodeURIComponent(b.token)}`);
  console.log('peek guarded token:', peekOk);
  if (peekOk.username !== 'Bob Test') {
    console.error('FAIL: peek username mismatch');
    process.exit(1);
  }
  const consumed = await api('/auth/recovery/consume', {
    method: 'POST',
    body: { token: b.token },
  });
  console.log('consume ok, ciphertext len', consumed.ciphertext.length);

  const link = `http://localhost:5173/?recover=${encodeURIComponent(b.token)}&k=${encodeURIComponent(b.key)}`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync('/tmp/recovery-link.txt', link + '\n');
  writeFileSync('/opt/cursor/artifacts/recovery_link.txt', link + '\n');
  console.log('wrote recovery link to /tmp/recovery-link.txt');
  console.log('PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
