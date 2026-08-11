# AGENTS.md

## Cursor Cloud specific instructions

Coachman (Ямщик) is an E2E-encrypted messenger: a React 19 + Vite + TypeScript PWA client
(`client/`) talking to a Go (Chi + WebSocket) backend (`server/`). Standard commands live in
the root `package.json`, `client/package.json`, and `README.md` — prefer those over duplicating
them here. Notes below are the non-obvious things that trip up a fresh clone.

### Toolchain

- The Go module requires **Go 1.25** (`server/go.mod`), which is newer than the image default.
  The environment build installs Go 1.25 at `/usr/local/go` and points `/usr/bin/go` at it, so
  `go version` should report 1.25 without any per-session setup. If it reports an older version,
  the snapshot was lost — reinstall Go 1.25 before building the server.
- Node 20+ is required; the image ships Node 22, which is fine.

### Running (development)

- `npm run dev` (from repo root) runs server + client together via `concurrently`.
  - Backend: Go API on `http://localhost:3001` (started with `COACHMAN_DEV=1`).
  - Frontend: Vite on `http://localhost:5173`. Vite **proxies** `/api`, `/ws`, `/health`, and
    `/runtime-config.js` to `:3001`, so always drive the app through **port 5173**.
- Vite binds to IPv6 `::1` only, so use `http://localhost:5173` (not `127.0.0.1`) when curling
  the client. The Go server listens on all interfaces.
- `dev:server` runs `lsof -ti :3001 | xargs kill -9` on start, so re-running `npm run dev` frees
  a stale backend automatically; a stale Vite on 5173 must be stopped manually.

### Database / config

- **No external services are needed for dev.** With no `DATABASE_URL`, the server falls back to
  **SQLite** at `server/data/coachman.db`. Postgres, Redis, and S3 are all optional (see README).
- Migrations run **automatically on server startup** (embedded SQL, idempotent) — there is no
  separate migrate step required for dev. `npm run migrate` exists but is not needed for SQLite.
- Config is read from `server/.env` (see `server/.env.example`). `server/.env` is gitignored;
  a dev copy with `COACHMAN_DEV=1` and `BOOTSTRAP_TOKEN=dev-bootstrap-token` is kept in the VM
  snapshot for local testing. To reset all data, stop the server and delete
  `server/data/coachman.db*`, then restart.

### Testing / lint / build

- Client: `npm run typecheck -w client`, `npm test -w client` (Vitest), `npm run build -w client`.
- Server: `npm run test:server` (or `cd server && go test ./...`), `go -C server build ./...`.
- There is no ESLint config; TypeScript `typecheck` (via `tsc -b`) is the client's static check.

### App usage (registration is invite-only)

- Open registration is disabled. The **first** user is created via a bootstrap link:
  `http://localhost:5173/?bootstrap=<BOOTSTRAP_TOKEN>` → enter a name → becomes admin.
- To test messaging you need a **second** user: as admin, open Settings (person icon, top-right)
  → "Пригласить друга" → create an invite link (`/?invite=<TOKEN>`), then open it in a separate
  browser storage partition (e.g. an **incognito window**) to register the invited user. Two
  normal tabs / two incognito windows share IndexedDB and will collide, so use one normal window
  + one incognito window for two-user tests.
- Auth is challenge-response (ECDSA) with device keys in IndexedDB; message text is E2E encrypted
  in the browser. Web Push, TURN video calls, FCM, and S3 photo storage require extra env vars
  and are not configured in dev by default.

### Commit hook

- A `.githooks/pre-commit` hook auto-bumps `client/package.json` patch version on every commit
  (hooks path is set by `npm run prepare`). Use `SKIP_VERSION_BUMP=1 git commit ...` to skip it.
