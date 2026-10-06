// Motion check in real time. A 390x844 phone (the host, CPU throttled 4x
// through the DevTools protocol) plays one round with three desktop players.
// For each big moment it records the moment's length, frame times while it
// plays, and any element GSAP left hidden. With --reduced it confirms that no
// view transition or GSAP moment starts at all.
//
//   BROWSER_PATH=... node design/motion-perf.mjs [--reduced] [--cpu 4]
//
// Headless Chromium renders in software, so frame times here are pessimistic
// compared with a phone's GPU compositor; treat them as relative, not absolute.
import { chromium, expect } from "@playwright/test";
import { createAlibiServer } from "../server/index.js";

const reduced = process.argv.includes("--reduced");
// --override: the device asks for reduced motion but the player turned
// motion on with the header toggle (stored in localStorage).
const override = process.argv.includes("--override");
// --no-vt removes the View Transitions API to isolate GSAP's own cost.
const noVt = process.argv.includes("--no-vt");
const cpuIndex = process.argv.indexOf("--cpu");
const cpu = cpuIndex > -1 ? Number(process.argv[cpuIndex + 1]) : 4;
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
async function open(nick, phone) {
  const context = await browser.newContext({
    viewport: phone
      ? { width: 390, height: 844 }
      : { width: 1280, height: 800 },
    // Only the measured phone animates; the other players' tabs run with
    // reduced motion so they do not compete for this machine's CPU.
    reducedMotion: phone && !reduced && !override ? "no-preference" : "reduce",
    isMobile: Boolean(phone),
    hasTouch: Boolean(phone),
  });
  if (phone && override)
    await context.addInitScript(() =>
      localStorage.setItem("alibi.motion", "full"),
    );
  if (phone && noVt)
    await context.addInitScript(() => {
      window.__noVt = true;
    });
  if (phone)
    await context.addInitScript(() => {
      window.__vt = 0;
      if (window.__noVt) delete Document.prototype.startViewTransition;
      window.__moments = [];
      // Long Animation Frames: main-thread time per slow frame, split into
      // script and style/layout, so software raster in headless is excluded.
      try {
        new PerformanceObserver((list) => {
          if (!window.__measuring) return;
          for (const e of list.getEntries())
            window.__loaf.push({
              duration: e.duration,
              script: e.scripts.reduce((t, s) => t + s.duration, 0),
              styleLayout: e.styleAndLayoutStart
                ? e.startTime + e.duration - e.styleAndLayoutStart
                : 0,
            });
        }).observe({ type: "long-animation-frame", buffered: false });
      } catch {}
      window.__measure = (on) => {
        if (!on) {
          window.__measuring = false;
          return window.__frameTimes;
        }
        window.__frameTimes = [];
        window.__loaf = [];
        window.__measuring = true;
        let last = performance.now();
        const loop = (now) => {
          if (!window.__measuring) return;
          window.__frameTimes.push(now - last);
          last = now;
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      };
      const watchRoot = () =>
        new MutationObserver(() => {
          const root = document.documentElement;
          if (root.dataset.vt) window.__vt++;
          if (root.dataset.moment) {
            window.__moments.push(root.dataset.moment);
            delete root.dataset.moment;
          }
        }).observe(document.documentElement, { attributes: true });
      if (document.documentElement) watchRoot();
      else document.addEventListener("DOMContentLoaded", watchRoot);
    });
  const page = await context.newPage();
  if (phone && cpu > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  }
  const p = { nick, page, state: null };
  page.on("pageerror", (e) => errors.push(`${nick}: ${e.message}`));
  page.on("websocket", (ws) =>
    ws.on("framereceived", (ev) => {
      const s = ev.payload.toString();
      if (!s.startsWith("42")) return;
      const [t, v] = JSON.parse(s.slice(2));
      if (t === "state") p.state = v;
    }),
  );
  await page.goto(base);
  await expect(page.locator("#connection")).toContainText("Connected", {
    timeout: 20000,
  });
  players.push(p);
  return p;
}
const btn = (page, name) => page.getByRole("button", { name, exact: true });
const until = (p, f) =>
  expect
    .poll(() => Boolean(p.state && f(p.state)), { timeout: 30000 })
    .toBe(true);
const all = (f) => Promise.all(players.map((p) => until(p, f)));
const rows = [];

const phone = await open("Kareem", true);
async function moment(label, trigger, settleMs = 2600) {
  await phone.page.evaluate(() => {
    window.__moments = [];
    window.__measure(true);
  });
  await trigger();
  await phone.page.waitForTimeout(settleMs);
  const result = await phone.page.evaluate(() => {
    const times = window.__measure(false).slice(1);
    const sorted = [...times].sort((a, b) => a - b);
    const stuck = [...document.querySelectorAll("#app [style]")].filter(
      (el) => el.style.opacity !== "" && Number(el.style.opacity) < 1,
    ).length;
    const loaf = window.__loaf || [];
    const worst = loaf.reduce(
      (a, b) => (b.duration > (a?.duration || 0) ? b : a),
      null,
    );
    return {
      loafCount: loaf.length,
      loafWorst: worst
        ? `${worst.duration.toFixed(0)} (js ${worst.script.toFixed(0)}, style ${worst.styleLayout.toFixed(0)})`
        : "-",
      moments: window.__moments,
      frames: times.length,
      p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
      max: sorted[sorted.length - 1] || 0,
      over50: times.filter((t) => t > 50).length,
      stuck,
    };
  });
  rows.push({ label, ...result });
}

await phone.page.getByLabel("What should we call you?").fill("Kareem");
await btn(phone.page, "Create a private room").click();
await until(phone, (s) => s.code);
for (const [i, nick] of ["Maya", "Dre", "Lina"].entries()) {
  const p = await open(nick, false);
  await btn(p.page, "Join a room").click();
  await p.page.getByLabel("Room code").fill(phone.state.code);
  await p.page.getByLabel("What should we call you?").fill(nick);
  await p.page.locator(`[data-avatar="${i + 1}"]`).click();
  await btn(p.page, "Join the room").click();
  await until(p, (s) => s.code === phone.state.code);
}
await all((s) => s.players.filter((x) => x.connected).length === 4);

await moment("phase: lobby to cards dealt", () =>
  btn(phone.page, "Start the round").click(),
);
await moment("revealing your card", () =>
  btn(phone.page, "Reveal my card").click(),
);
await phone.page.getByRole("button", { name: "Hide my card" }).click();
for (const p of players)
  await btn(p.page, "I’m ready")
    .click()
    .catch(() => {});
await all((s) => s.phase === "clues");
// Speaking turns until the phone's own turn comes up, measuring each change.
for (let n = 0; n < 4; n++) {
  const cur = players.find((p) => p.state.me.id === phone.state.turn.currentId);
  const nextIndex = phone.state.turn.order.indexOf(cur.state.me.id) + 1;
  const nextId = phone.state.turn.order[nextIndex];
  const label = !nextId
    ? "phase: clues to discussion"
    : "speaking turn changes";
  const turnId = phone.state.turn.id;
  await moment(label, async () => {
    await btn(cur.page, "Done with my clue").click();
    await all((s) => s.phase === "discussion" || s.turn?.id !== turnId);
  });
}
await all((s) => s.phase === "discussion");
await moment("phase: voting opens", () =>
  btn(phone.page, "Start private voting").click(),
);
const imposter = players.find((p) => p.state.me.role === "imposter");
const others = players.filter((p) => p !== phone);
const accuse =
  imposter === phone ? others[0].state.me.id : imposter.state.me.id;
await moment(
  "picking a suspect",
  () => phone.page.locator(`[data-vote="${accuse}"]`).click(),
  900,
);
for (const p of others) {
  const target = p === imposter ? phone.state.me.id : imposter.state.me.id;
  await p.page.locator(`[data-vote="${target}"]`).click();
  await btn(p.page, "Lock in my vote").click();
}
await moment("vote reveal: the accusation", () =>
  btn(phone.page, "Lock in my vote").click(),
);
await moment(
  "imposter reveal and stamp",
  async () => {
    await imposter.page.getByLabel("Your final guess").fill("pretzel");
    await btn(imposter.page, "Submit final guess").click();
  },
  3200,
);

const vtCount = await phone.page.evaluate(() => window.__vt);
console.log(
  `${reduced ? "REDUCED MOTION" : override ? "DEVICE REDUCED, PLAYER TURNED MOTION ON" : noVt ? "GSAP ONLY" : "MOTION"} · phone 390x844 · CPU ${cpu}x · view transitions started: ${vtCount}`,
);
console.table(
  rows.map((r) => ({
    moment: r.label,
    played: r.moments.join(", ") || "none",
    frames: r.frames,
    "p95 ms": r.p95.toFixed(1),
    "max ms": r.max.toFixed(1),
    ">50ms": r.over50,
    "long frames": r.loafCount,
    "worst long frame ms": r.loafWorst,
    "stuck hidden": r.stuck,
  })),
);
if (errors.length) console.log(`PAGE ERRORS:\n${errors.join("\n")}`);
await browser.close();
process.exit(errors.length ? 1 : 0);
