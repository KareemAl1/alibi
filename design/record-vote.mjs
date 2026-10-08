// Records the vote reveal as a 30fps clip: the last voter picks and locks a
// suspect, the ballot closes on the caught imposter, the imposter guesses, and
// results land. Filmed from the last voter's seat in a separate tab.
//
// Frames are rendered on a virtual clock: GSAP's ticker runs from a stepped
// Date.now, and every Web Animation (CSS animations, transitions,
// view-transition pseudo-elements) is paused and stepped 1/30s per screenshot. Headless screencasts drop most
// frames under load, so this shows the motion as designed. It is not a
// performance measurement; see design/motion-perf.mjs for that.
//
//   BROWSER_PATH=... node design/record-vote.mjs --out DIR [--only phone|desktop] [--reduced]
import { chromium, expect } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createAlibiServer } from "../server/index.js";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const out = path.resolve(arg("out") || "artifacts/design/clips/current");
const only = arg("only") || "phone";
const reduced = process.argv.includes("--reduced");
const FPS = 30;
await mkdir(out, { recursive: true });
const server = await createAlibiServer();
const base = `http://127.0.0.1:${await server.listen()}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_PATH
    ? { executablePath: process.env.BROWSER_PATH }
    : {}),
});
const errors = [];
const players = [];
function watch(p, page, label) {
  page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
  page.on("websocket", (ws) =>
    ws.on("framereceived", (ev) => {
      const s = ev.payload.toString();
      if (!s.startsWith("42")) return;
      const [t, v] = JSON.parse(s.slice(2));
      if (t === "state") p.state = v;
    }),
  );
}
async function open(nick) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const p = { nick, context, page, state: null };
  watch(p, page, nick);
  await page.goto(base);
  await expect(page.locator("#connection")).toContainText("Connected");
  players.push(p);
  return p;
}
const btn = (page, name) => page.getByRole("button", { name, exact: true });
const until = (p, f) =>
  expect
    .poll(() => Boolean(p.state && f(p.state)), { timeout: 20000 })
    .toBe(true);
const all = (f) => Promise.all(players.map((p) => until(p, f)));

const names = ["Kareem", "Maya", "Dre", "Lina"];
const host = await open(names[0]);
await host.page.getByLabel("What should we call you?").fill(host.nick);
await btn(host.page, "Create a private room").click();
await until(host, (s) => s.code);
for (const [i, nick] of names.slice(1).entries()) {
  const p = await open(nick);
  await btn(p.page, "Join a room").click();
  await p.page.getByLabel("Room code").fill(host.state.code);
  await p.page.getByLabel("What should we call you?").fill(nick);
  await p.page.locator(`[data-part="face"][data-value="${i + 1}"]`).click();
  await btn(p.page, "Join the room").click();
  await until(p, (s) => s.code === host.state.code);
}
await all((s) => s.players.filter((x) => x.connected).length === 4);
await btn(host.page, "Start the round").click();
await all((s) => s.phase === "reveal");
for (const p of players) {
  await btn(p.page, "Reveal my card").click();
  await p.page.getByRole("button", { name: "Hide my card" }).click();
  await btn(p.page, "I’m ready").click();
}
await all((s) => s.phase === "clues");
for (let n = 0; n < 4; n++) {
  const cur = players.find((p) => p.state.me.id === host.state.turn.currentId);
  const turnId = host.state.turn.id;
  await btn(cur.page, "Done with my clue").click();
  await all((s) => s.phase === "discussion" || s.turn?.id !== turnId);
}
await all((s) => s.phase === "discussion");
await btn(host.page, "Start private voting").click();
await all((s) => s.phase === "voting");
const imposter = players.find((p) => p.state.me.role === "imposter");
const last = players.find((p) => p !== imposter);
for (const p of players.filter((p) => p !== last)) {
  const target = p === imposter ? last.state.me.id : imposter.state.me.id;
  await p.page.locator(`[data-vote="${target}"]`).click();
  await btn(p.page, "Lock in my vote").click();
}
await all((s) => s.voting.submitted === 3);

// The filming tab shares the last voter's seat (same cookies, same player).
const viewport =
  only === "desktop"
    ? { width: 1280, height: 800 }
    : { width: 390, height: 844 };
const context = await browser.newContext({ viewport });
if (reduced)
  await context.addInitScript(() =>
    localStorage.setItem("alibi.motion", "reduced"),
  );
await context.addCookies(await last.context.cookies());
// GSAP reads Date.now when it loads. In frame mode this clock stands still
// between frames and advances exactly one frame per screenshot.
await context.addInitScript(() => {
  const real = Date.now.bind(Date);
  window.__frameMode = false;
  window.__virtualNow = 0;
  Date.now = () => (window.__frameMode ? window.__virtualNow : real());
});
const page = await context.newPage();
const cam = { state: null };
watch(cam, page, `camera-${only}`);
await page.goto(base);
await until(cam, (s) => s.phase === "voting");
await page.evaluate(async () => {
  await document.fonts.ready;
  await Promise.all(
    [...document.images].map((img) => img.decode().catch(() => {})),
  );
});
await page.locator(".vote-grid").scrollIntoViewIfNeeded();

const frames = path.join(out, `frames-${only}${reduced ? "-reduced" : ""}`);
await rm(frames, { recursive: true, force: true });
await mkdir(frames, { recursive: true });
await page.evaluate(() => {
  window.__virtualNow = Date.now();
  window.__frameMode = true;
  window.__soundLog = [];
  window.__clipStart = window.__virtualNow;
  window.gsap?.ticker.lagSmoothing(0);
  window.__clock = { t: 0, seen: new Map() };
});
let frame = 0;
async function film(seconds) {
  for (let i = 0; i < Math.round(seconds * FPS); i++) {
    await page.evaluate((dt) => {
      const c = window.__clock;
      c.t += dt;
      window.__virtualNow += dt * 1000;
      window.gsap?.ticker.tick();
      for (const a of document.getAnimations()) {
        if (!c.seen.has(a)) c.seen.set(a, c.t - dt);
        a.pause();
        a.currentTime = (c.t - c.seen.get(a)) * 1000;
      }
    }, 1 / FPS);
    await page.screenshot({
      path: path.join(frames, `f-${String(frame++).padStart(4, "0")}.png`),
    });
  }
}
// Let real messages and the view transition's update callback land, while the
// virtual clock stands still.
const settle = () => page.waitForTimeout(160);

await film(0.8);
await page.locator(`[data-vote="${imposter.state.me.id}"]`).click();
await settle();
await film(0.5);
await btn(page, "Lock in my vote").click();
await until(cam, (s) => s.phase === "guess");
await settle();
await film(2.4);
await imposter.page.getByLabel("Your final guess").fill("pretzel");
await btn(imposter.page, "Submit final guess").click();
await until(cam, (s) => s.phase === "results");
await settle();
await film(3);

// Sound: the cues this tab fired, on the clip's clock, rendered offline with
// the game's own synth (public/sound.js), plus the voting heartbeat until the
// ballot closed. Written as a WAV and muxed into the clip.
const seconds = frame / FPS;
const wav = await page.evaluate(async (seconds) => {
  const { renderOffline } = await import("/sound.js");
  const start = window.__clipStart;
  const cues = window.__soundLog.map((c) => ({
    name: c.name,
    at: Math.max(0, (c.at - start) / 1000),
  }));
  const accuse = cues.find((c) => c.name === "accuse");
  const buffer = await renderOffline(cues, seconds, {
    loops: [
      { name: "heart", from: 0.2, to: accuse ? accuse.at : seconds, bpm: 84 },
    ],
  });
  const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
  const length = buffer.length;
  const view = new DataView(new ArrayBuffer(44 + length * 4));
  const text = (o, s) =>
    [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + length * 4, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length * 4, true);
  for (let i = 0, o = 44; i < length; i++)
    for (const ch of channels) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      view.setInt16(o, v * 0x7fff, true);
      o += 2;
    }
  let binary = "";
  const bytes = new Uint8Array(view.buffer);
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    base64: btoa(binary),
    cues: cues.map((c) => `${c.at.toFixed(2)}s ${c.name}`),
  };
}, seconds);
const audioPath = path.join(out, `vote-reveal-${only}.wav`);
await writeFile(audioPath, Buffer.from(wav.base64, "base64"));
console.log(`sound cues: ${wav.cues.join(", ")}`);

const clip = path.join(
  out,
  `vote-reveal-${only}${reduced ? "-reduced" : ""}.mp4`,
);
execFileSync("ffmpeg", [
  "-y",
  "-loglevel",
  "error",
  "-framerate",
  String(FPS),
  "-i",
  path.join(frames, "f-%04d.png"),
  "-i",
  audioPath,
  "-c:a",
  "aac",
  "-b:a",
  "160k",
  "-shortest",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  "-crf",
  "22",
  "-movflags",
  "+faststart",
  clip,
]);
console.log(clip);
if (errors.length) console.log(`PAGE ERRORS:\n${errors.join("\n")}`);
await browser.close();
process.exit(errors.length ? 1 : 0);
