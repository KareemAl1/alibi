// Alibi's sound, synthesized with the Web Audio API: no audio files.
// Quiet by design so it sits under a Discord call. Nothing here touches game
// state; app.js tells it what happened.
//
// - Audio starts on the first tap or key press (browsers require a gesture).
// - Mute is remembered on this device (localStorage "alibi.sound").
// - Every voice is a function (ctx, out, t) so the same code renders live or
//   into an OfflineAudioContext (used to measure loudness and to put real
//   sound on review clips).

const KEY = "alibi.sound";
// Master level. Peaks land around -20 dBFS.
const MASTER = 0.32;
const MUSIC = 0.16; // relative to master

let ctx = null;
let master = null;
let musicBus = null;
let unlocked = false;
let scene = { phase: "entry", votingRatio: 0 };
let music = null; // { nextBeat, beat, timer }
let heart = null; // { next, timer }

export function soundEnabled() {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}
export function setSoundEnabled(on) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {}
  if (!on) stopLoops();
  if (master && ctx)
    master.gain.setTargetAtTime(on ? MASTER : 0, ctx.currentTime, 0.05);
  if (on) {
    unlock();
    updateLoops();
  }
}

function build(context) {
  const comp = context.createDynamicsCompressor();
  comp.threshold.value = -24;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;
  comp.connect(context.destination);
  const out = context.createGain();
  out.connect(comp);
  const bus = context.createGain();
  bus.gain.value = MUSIC;
  bus.connect(out);
  return { out, bus };
}

/** Create or resume audio. Called from the first user gesture. */
export function unlock() {
  if (!soundEnabled()) return;
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC({ latencyHint: "interactive" });
      const nodes = build(ctx);
      master = nodes.out;
      musicBus = nodes.bus;
      master.gain.value = MASTER;
    }
    if (ctx.state === "suspended") ctx.resume();
    unlocked = true;
    updateLoops();
  } catch {}
}

const live = () => unlocked && ctx && soundEnabled() && !document.hidden;

/** Play a one-shot effect now, or `delay` seconds from now. */
export function sfx(name, delay = 0) {
  if (!live() || !voices[name]) return;
  voices[name](ctx, master, ctx.currentTime + 0.01 + delay);
  // Review clips (design/record-vote.mjs) collect cues to render offline.
  if (window.__soundLog)
    window.__soundLog.push({ name, at: Date.now() + delay * 1000 });
}

/** Tell the sound which scene is on screen (drives the loops). */
export function setScene(next) {
  scene = { ...scene, ...next };
  updateLoops();
}

function updateLoops() {
  if (!live()) return stopLoops();
  if (scene.phase === "lobby") startMusic();
  else stopMusic();
  if (scene.phase === "voting" || scene.phase === "runoff") startHeart();
  else stopHeart();
}
function stopLoops() {
  stopMusic();
  stopHeart();
}
document.addEventListener("visibilitychange", () => {
  if (!ctx) return;
  // Switching to Discord or locking the phone silences everything.
  if (document.hidden) {
    stopLoops();
    ctx.suspend?.();
  } else if (soundEnabled() && unlocked) {
    ctx.resume?.();
    updateLoops();
  }
});

// ---------- loops ----------

// Lobby: a slow noir vamp in D minor, 76 bpm. Upright bass walks, brushes on
// two and four, a soft electric-piano chord each bar.
const BPM = 76;
const BAR = [
  // chord tones (Hz) and the bass walk for each bar
  { chord: [146.83, 174.61, 220, 261.63], bass: [73.42, 87.31, 110, 103.83] }, // Dm7
  { chord: [116.54, 146.83, 174.61, 220], bass: [58.27, 73.42, 87.31, 98] }, // Bbmaj7
  { chord: [98, 116.54, 146.83, 174.61], bass: [49, 58.27, 73.42, 69.3] }, // Gm7
  { chord: [110, 138.59, 164.81, 196], bass: [55, 69.3, 82.41, 77.78] }, // A7
];
function startMusic() {
  if (music) return;
  const beatLen = 60 / BPM;
  const now = ctx.currentTime + 0.1;
  musicBus.gain.cancelScheduledValues(now);
  musicBus.gain.setValueAtTime(0, now);
  musicBus.gain.linearRampToValueAtTime(MUSIC, now + 2);
  music = { next: now, beat: 0, timer: null };
  const schedule = () => {
    while (music && music.next < ctx.currentTime + 0.4) {
      const bar = BAR[Math.floor(music.beat / 4) % BAR.length];
      const step = music.beat % 4;
      noirBeat(ctx, musicBus, music.next, bar, step, beatLen);
      music.next += beatLen;
      music.beat++;
    }
  };
  schedule();
  music.timer = setInterval(schedule, 150);
}
function stopMusic() {
  if (!music) return;
  clearInterval(music.timer);
  const now = ctx.currentTime;
  musicBus.gain.cancelScheduledValues(now);
  musicBus.gain.setTargetAtTime(0, now, 0.25);
  music = null;
  setTimeout(() => {
    if (!music && musicBus) musicBus.gain.value = MUSIC;
  }, 1500);
}
export function noirBeat(c, out, t, bar, step, beatLen) {
  pluckBass(c, out, t, bar.bass[step], beatLen * 0.9);
  if (step === 1 || step === 3) brush(c, out, t, 0.05);
  brush(c, out, t + beatLen * 0.66, 0.018);
  if (step === 0) keys(c, out, t + 0.02, bar.chord, beatLen * 3.6);
}

// Voting: a heartbeat that quickens as the votes come in.
function startHeart() {
  if (heart) return;
  heart = { next: ctx.currentTime + 0.2, timer: null };
  const schedule = () => {
    if (!heart) return;
    const bpm = 58 + 34 * Math.min(1, scene.votingRatio || 0);
    while (heart.next < ctx.currentTime + 0.4) {
      heartbeat(ctx, master, heart.next);
      heart.next += 60 / bpm;
    }
  };
  schedule();
  heart.timer = setInterval(schedule, 150);
}
function stopHeart() {
  if (!heart) return;
  clearInterval(heart.timer);
  heart = null;
}

// ---------- voices ----------

function env(c, t, attack, peak, decay) {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}
function tone(c, out, t, type, freq, attack, peak, decay, to) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  const g = env(c, t, attack, peak, decay);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
  return o;
}
const noiseBuffers = new WeakMap();
function noise(c) {
  if (!noiseBuffers.has(c)) {
    const b = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = b.getChannelData(0);
    let seed = 7;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 16807) % 2147483647;
      d[i] = (seed / 2147483647) * 2 - 1;
    }
    noiseBuffers.set(c, b);
  }
  const s = c.createBufferSource();
  s.buffer = noiseBuffers.get(c);
  return s;
}
function burst(c, out, t, type, freq, q, peak, decay, sweepTo) {
  const s = noise(c);
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + decay);
  f.Q.value = q;
  const g = env(c, t, 0.003, peak, decay);
  s.connect(f).connect(g).connect(out);
  s.start(t, Math.random() * 0.5);
  s.stop(t + decay + 0.05);
}
function pluckBass(c, out, t, freq, len) {
  const o = c.createOscillator();
  o.type = "triangle";
  o.frequency.value = freq;
  const f = c.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.setValueAtTime(900, t);
  f.frequency.exponentialRampToValueAtTime(220, t + 0.25);
  const g = env(c, t, 0.008, 0.5, len);
  o.connect(f).connect(g).connect(out);
  o.start(t);
  o.stop(t + len + 0.1);
}
function brush(c, out, t, peak) {
  burst(c, out, t, "highpass", 5200, 0.7, peak, 0.12);
}
function keys(c, out, t, chord, len) {
  chord.forEach((f, i) => {
    tone(c, out, t + i * 0.012, "sine", f * 2, 0.02, 0.07, len);
    tone(c, out, t + i * 0.012, "triangle", f * 4, 0.01, 0.012, len * 0.4);
  });
}
function heartbeat(c, out, t) {
  // lub
  tone(c, out, t, "sine", 62, 0.012, 0.075, 0.14, 44);
  burst(c, out, t, "lowpass", 160, 0.7, 0.025, 0.08);
  // dub
  tone(c, out, t + 0.2, "sine", 54, 0.012, 0.05, 0.16, 40);
}

export const voices = {
  // Any button: a soft wooden tick.
  tap(c, out, t) {
    tone(c, out, t, "sine", 880, 0.002, 0.08, 0.035, 520);
    burst(c, out, t, "bandpass", 2400, 4, 0.05, 0.025);
  },
  // Turning your card: a paper swipe and snap.
  flip(c, out, t) {
    burst(c, out, t, "bandpass", 900, 1.2, 0.16, 0.16, 3600);
    burst(c, out, t + 0.15, "bandpass", 3000, 2, 0.12, 0.04);
    tone(c, out, t + 0.15, "sine", 420, 0.002, 0.06, 0.06, 260);
  },
  // Your clue turn: two soft vibraphone notes.
  turn(c, out, t) {
    tone(c, out, t, "sine", 587.33, 0.005, 0.12, 0.7);
    tone(c, out, t + 0.14, "sine", 880, 0.005, 0.1, 0.9);
    tone(c, out, t + 0.14, "sine", 1760, 0.003, 0.015, 0.3);
  },
  // A vote locks: a latch clicking shut.
  lock(c, out, t) {
    burst(c, out, t, "bandpass", 1800, 6, 0.14, 0.03);
    tone(c, out, t + 0.04, "square", 190, 0.002, 0.035, 0.05, 120);
    burst(c, out, t + 0.05, "bandpass", 1200, 5, 0.1, 0.04);
  },
  // The ballot closes on someone: a low hit and a held dissonance.
  accuse(c, out, t) {
    tone(c, out, t, "sine", 82, 0.005, 0.2, 0.5, 48);
    burst(c, out, t, "lowpass", 400, 0.8, 0.1, 0.25);
    [146.83, 155.56, 207.65].forEach((f) =>
      tone(c, out, t + 0.02, "triangle", f, 0.03, 0.035, 1.1),
    );
  },
  // The imposter turns around: a muted-brass noir sting, down a tritone.
  sting(c, out, t) {
    const notes = [
      [293.66, 0],
      [349.23, 0],
      [415.3, 0],
      [207.65, 0.32],
      [246.94, 0.32],
      [293.66, 0.32],
    ];
    notes.forEach(([f, d]) => {
      const o = c.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 12;
      const lp = c.createBiquadFilter();
      lp.type = "lowpass";
      lp.Q.value = 3;
      lp.frequency.setValueAtTime(400, t + d);
      lp.frequency.exponentialRampToValueAtTime(1800, t + d + 0.08);
      lp.frequency.exponentialRampToValueAtTime(500, t + d + 0.9);
      const g = env(c, t + d, 0.03, d ? 0.022 : 0.018, d ? 1.1 : 0.35);
      o.connect(lp).connect(g).connect(out);
      o.start(t + d);
      o.stop(t + d + 1.3);
    });
    tone(c, out, t + 0.32, "sine", 103.83, 0.01, 0.12, 0.9);
  },
  // The stamp hits the case file.
  thud(c, out, t) {
    tone(c, out, t, "sine", 120, 0.003, 0.24, 0.22, 46);
    burst(c, out, t, "lowpass", 900, 0.9, 0.14, 0.09);
    burst(c, out, t + 0.012, "bandpass", 2600, 3, 0.05, 0.03);
  },
  // Getaway: the imposter escaped. A rising, unresolved figure.
  escape(c, out, t) {
    [220, 261.63, 311.13, 369.99].forEach((f, i) =>
      tone(c, out, t + i * 0.09, "triangle", f, 0.01, 0.07, 0.5),
    );
  },
};

/** What is playing right now (used by design/sound-check.mjs). */
export function soundStatus() {
  return {
    context: ctx?.state || "none",
    enabled: soundEnabled(),
    music: Boolean(music),
    heartbeat: Boolean(heart),
  };
}

/** Render a list of {name, at} events offline, for tests and review clips. */
export async function renderOffline(events, seconds, { loops = [] } = {}) {
  const rate = 44100;
  const c = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
  const { out, bus } = build(c);
  out.gain.value = MASTER;
  for (const e of events) voices[e.name]?.(c, out, e.at);
  for (const loop of loops) {
    if (loop.name === "heart") {
      let t = loop.from;
      while (t < loop.to) {
        heartbeat(c, out, t);
        t += 60 / (loop.bpm || 70);
      }
    }
    if (loop.name === "music") {
      const beatLen = 60 / BPM;
      let beat = 0;
      for (let t = loop.from; t < loop.to; t += beatLen, beat++)
        noirBeat(c, bus, t, BAR[Math.floor(beat / 4) % 4], beat % 4, beatLen);
    }
  }
  return c.startRendering();
}
