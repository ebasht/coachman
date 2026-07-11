/** Dual-tone ringtone + vibration — phone-like ring while waiting. */

let audioCtx: AudioContext | null = null;
let ringTimer: ReturnType<typeof setInterval> | null = null;
let vibratorTimer: ReturnType<typeof setInterval> | null = null;
let playing = false;

function getCtx(): AudioContext | null {
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  return audioCtx;
}

function beep(ctx: AudioContext, freq: number, start: number, duration: number, gain = 0.08) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.02);
  g.gain.setValueAtTime(gain, start + duration - 0.05);
  g.gain.linearRampToValueAtTime(0, start + duration);
  osc.connect(g);
  g.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.01);
}

/** One classic ring burst (~2s): two tones alternating. */
function playBurst(ctx: AudioContext) {
  const t0 = ctx.currentTime + 0.01;
  // Rough North-American-ish ring cadence
  beep(ctx, 440, t0, 0.4);
  beep(ctx, 480, t0, 0.4);
  beep(ctx, 440, t0 + 0.5, 0.4);
  beep(ctx, 480, t0 + 0.5, 0.4);
}

function vibrateBurst() {
  if (!navigator.vibrate) return;
  try {
    navigator.vibrate([400, 200, 400, 200, 400, 800]);
  } catch {
    // ignore
  }
}

export function startCallRingtone() {
  if (playing) return;
  playing = true;
  const ctx = getCtx();
  if (ctx) {
    void ctx.resume().then(() => {
      playBurst(ctx);
      ringTimer = setInterval(() => {
        if (!playing || !audioCtx) return;
        void audioCtx.resume();
        playBurst(audioCtx);
      }, 2800);
    });
  }
  vibrateBurst();
  vibratorTimer = setInterval(() => {
    if (!playing) return;
    vibrateBurst();
  }, 2800);
}

export function stopCallRingtone() {
  playing = false;
  if (ringTimer) {
    clearInterval(ringTimer);
    ringTimer = null;
  }
  if (vibratorTimer) {
    clearInterval(vibratorTimer);
    vibratorTimer = null;
  }
  if (navigator.vibrate) {
    try {
      navigator.vibrate(0);
    } catch {
      // ignore
    }
  }
}
