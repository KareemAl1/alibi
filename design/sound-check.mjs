// Renders every sound offline in a real browser and reports its level, so
// "quiet enough for a Discord call" is a number, not a guess.
//
//   BROWSER_PATH=... node design/sound-check.mjs
//
// Levels are dBFS at full device volume: peak (loudest sample) and RMS over
// the sound's audible span. For reference, speech on a call usually sits
// around -20 to -12 dBFS RMS.
import { chromium } from "@playwright/test";
import { createAlibiServer } from "../server/index.js";

const server = await createAlibiServer();
const base = `http://127.0.0.1:${await server.listen()}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_PATH
    ? { executablePath: process.env.BROWSER_PATH }
    : {}),
});
const page = await browser.newPage();
await page.goto(base);
const rows = await page.evaluate(async () => {
  const { renderOffline, voices } = await import("/sound.js");
  const measure = (buffer) => {
    const d = buffer.getChannelData(0);
    let peak = 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
      if (v > 0.0005) {
        sum += d[i] * d[i];
        n++;
      }
    }
    const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
    return {
      peak: db(peak).toFixed(1),
      rms: db(Math.sqrt(sum / Math.max(1, n))).toFixed(1),
      seconds: (n / buffer.sampleRate).toFixed(2),
    };
  };
  const out = [];
  for (const name of Object.keys(voices)) {
    const buffer = await renderOffline([{ name, at: 0.05 }], 2.2);
    out.push({ sound: name, ...measure(buffer) });
  }
  out.push({
    sound: "heartbeat loop (70 bpm)",
    ...measure(
      await renderOffline([], 5, {
        loops: [{ name: "heart", from: 0.05, to: 5, bpm: 70 }],
      }),
    ),
  });
  out.push({
    sound: "lobby music (16 beats)",
    ...measure(
      await renderOffline([], 13, {
        loops: [{ name: "music", from: 0.05, to: 12.7 }],
      }),
    ),
  });
  return out;
});
console.table(
  rows.map((r) => ({
    sound: r.sound,
    "peak dBFS": r.peak,
    "RMS dBFS": r.rms,
    "audible s": r.seconds,
  })),
);

// Live flow: music on first tap in the lobby, mute remembered across a
// reload, heartbeat only while voting.
const { expect } = await import("@playwright/test");
const players = [];
async function open(nick) {
  const context = await browser.newContext();
  const p = { page: await context.newPage(), state: null };
  p.page.on("websocket", (ws) =>
    ws.on("framereceived", (ev) => {
      const s = ev.payload.toString();
      if (!s.startsWith("42")) return;
      const [t, v] = JSON.parse(s.slice(2));
      if (t === "state") p.state = v;
    }),
  );
  await p.page.goto(base);
  await expect(p.page.locator("#connection")).toContainText("Connected");
  players.push(p);
  return p;
}
const btn = (page, n) => page.getByRole("button", { name: n, exact: true });
const until = (p, f) =>
  expect
    .poll(() => Boolean(p.state && f(p.state)), { timeout: 20000 })
    .toBe(true);
// Phase cues run inside the view-transition update, a frame or two after the
// state arrives, so let the page settle before reading what is playing.
const status = async (p) => {
  await p.page.waitForTimeout(400);
  return p.page.evaluate(async () => (await import("/sound.js")).soundStatus());
};
const checks = [];
const check = (label, ok) =>
  checks.push({ check: label, result: ok ? "pass" : "FAIL" });

const host = await open("Kareem");
check("no audio before any tap", (await status(host)).context === "none");
await host.page.getByLabel("What should we call you?").fill("Kareem");
await btn(host.page, "Create a private room").click();
await until(host, (s) => s.phase === "lobby");
let st = await status(host);
check(
  "first tap starts audio and the lobby music",
  st.context === "running" && st.music,
);
await host.page.locator("#sound-toggle").click();
st = await status(host);
check("mute stops the music", !st.music && !st.enabled);
check(
  "toggle shows Sound off",
  (await host.page.locator("#sound-toggle").getAttribute("aria-pressed")) ===
    "false",
);
await host.page.reload();
await until(host, (s) => s.phase === "lobby");
await host.page.locator("body").click({ position: { x: 5, y: 300 } });
st = await status(host);
check("mute is remembered after a reload", !st.enabled && !st.music);
await host.page.locator("#sound-toggle").click();
st = await status(host);
check("unmute brings the music back", st.enabled && st.music);
for (const n of ["Maya", "Dre", "Lina"]) {
  const p = await open(n);
  await btn(p.page, "Join a room").click();
  await p.page.getByLabel("Room code").fill(host.state.code);
  await p.page.getByLabel("What should we call you?").fill(n);
  await btn(p.page, "Join the room").click();
  await until(p, (s) => s.code === host.state.code);
}
await until(host, (s) => s.players.filter((x) => x.connected).length === 4);
await btn(host.page, "Start the round").click();
for (const p of players) {
  await until(p, (s) => s.phase === "reveal");
  await btn(p.page, "I’m ready").click();
}
await until(host, (s) => s.phase === "clues");
st = await status(host);
check("music stops when the round starts", !st.music);
for (let i = 0; i < 4; i++) {
  const cur = players.find((p) => p.state.me.id === host.state.turn.currentId);
  const turn = host.state.turn.id;
  await btn(cur.page, "Done with my clue").click();
  await until(host, (s) => s.phase === "discussion" || s.turn?.id !== turn);
}
await until(host, (s) => s.phase === "discussion");
await btn(host.page, "Start private voting").click();
await until(host, (s) => s.phase === "voting");
st = await status(host);
check("heartbeat runs during voting", st.heartbeat);
const imposter = players.find((p) => p.state.me.role === "imposter");
for (const p of players) {
  const target =
    p === imposter
      ? players.find((q) => q !== p).state.me.id
      : imposter.state.me.id;
  await p.page.locator(`[data-vote="${target}"]`).click();
  await btn(p.page, "Lock in my vote").click();
}
await until(host, (s) => s.phase === "guess");
st = await status(host);
check("heartbeat stops when the ballot closes", !st.heartbeat);
console.table(checks);
await browser.close();
await server.close();
process.exit(checks.every((c) => c.result === "pass") ? 0 : 1);
