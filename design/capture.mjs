// Design review capture: plays one real round with four independent browser
// contexts and screenshots each screen at desktop and phone widths.
// Optionally layers a direction stylesheet from design/ on top of the live app.
//
//   node design/capture.mjs --out artifacts/design/current
//   node design/capture.mjs --css design/directions/lineup.css --out artifacts/design/lineup
//
// Output stays in ignored artifacts/. Uses the real server and UI; no test endpoints.
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createAlibiServer } from "../server/index.js";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const css = arg("css");
const out = arg("out") || "artifacts/design/current";
await mkdir(out, { recursive: true });
const designRoot = path.resolve("design");

const server = await createAlibiServer();
const port = await server.listen();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_PATH
    ? { executablePath: process.env.BROWSER_PATH }
    : {}),
});
const errors = [];
const headings = [];
const players = [];

async function open(nick) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  // Still screenshots: the player's own motion choice, set to reduced.
  await context.addInitScript(() =>
    localStorage.setItem("alibi.motion", "reduced"),
  );
  await context.route("**/__design/**", async (route) => {
    const file = path.join(
      designRoot,
      new URL(route.request().url()).pathname.replace("/__design/", ""),
    );
    if (!file.startsWith(designRoot)) return route.abort();
    const type = file.endsWith(".css")
      ? "text/css"
      : file.endsWith(".woff2")
        ? "font/woff2"
        : "application/octet-stream";
    route.fulfill({ body: await readFile(file), contentType: type });
  });
  if (css)
    await context.addInitScript(
      (href) => {
        document.addEventListener("DOMContentLoaded", () => {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = href;
          document.head.append(link);
        });
      },
      `/__design/${path.relative(designRoot, path.resolve(css))}`,
    );
  const page = await context.newPage();
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
  players.push(p);
  await page.goto(base);
  await expect(page.locator("#connection")).toContainText("Connected");
  return p;
}
const btn = (p, name) => p.page.getByRole("button", { name, exact: true });
const until = (p, f, timeout = 15000) =>
  expect.poll(() => Boolean(p.state && f(p.state)), { timeout }).toBe(true);
const all = (f) => Promise.all(players.map((p) => until(p, f)));
async function shot(p, name) {
  for (const [suffix, width, height] of [
    ["desktop", 1280, 900],
    ["phone", 390, 844],
  ]) {
    await p.page.setViewportSize({ width, height });
    await p.page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        [...document.images].map((img) => img.decode().catch(() => {})),
      );
    });
    await p.page.evaluate(() => scrollTo(0, 0));
    const overflow = await p.page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    if (overflow) errors.push(`${name} ${suffix}: horizontal overflow`);
    // One big all-caps heading per screen: count visible headings at 28px+
    // that render in capitals (CSS uppercase or all-caps text).
    const caps = await p.page.evaluate(() =>
      [...document.querySelectorAll("main h1, main h2, main h3")]
        .filter((el) => {
          const cs = getComputedStyle(el);
          const text = el.innerText.trim();
          return (
            el.offsetParent !== null &&
            parseFloat(cs.fontSize) >= 28 &&
            /[a-z]/i.test(text) &&
            (cs.textTransform === "uppercase" || text === text.toUpperCase())
          );
        })
        .map((el) => el.innerText.trim().replace(/\s+/g, " ")),
    );
    headings.push(`${name}-${suffix}: ${caps.length} (${caps.join(" | ")})`);
    if (caps.length > 1)
      errors.push(`${name} ${suffix}: ${caps.length} big all-caps headings`);
    await p.page.screenshot({
      path: `${out}/${name}-${suffix}.png`,
      fullPage: true,
    });
  }
  await p.page.setViewportSize({ width: 1280, height: 900 });
}

const names = ["Kareem", "Maya", "Dre", "Lina"];
const host = await open(names[0]);
await shot(host, "1-entry");
await host.page.getByLabel("What should we call you?").fill(host.nick);
await btn(host, "Create a private room").click();
await until(host, (s) => s.code);
const code = host.state.code;
for (const [i, nick] of names.slice(1).entries()) {
  const p = await open(nick);
  await btn(p, "Join a room").click();
  await p.page.getByLabel("Room code").fill(code);
  await p.page.getByLabel("What should we call you?").fill(nick);
  await p.page.locator(`[data-part="face"][data-value="${i + 1}"]`).click();
  await btn(p, "Join the room").click();
  await until(p, (s) => s.code === code);
}
await all((s) => s.players.filter((x) => x.connected).length === 4);
await shot(host, "2-lobby");
await btn(host, "Start the round").click();
await all((s) => s.phase === "reveal");
const imposter = players.find((p) => p.state.me.role === "imposter");
const insider = players.find((p) => p.state.me.role === "insider");
await btn(insider, "Reveal my card").click();
await shot(insider, "3-card-insider");
await btn(imposter, "Reveal my card").click();
await shot(imposter, "3-card-imposter");
for (const p of players) {
  if (p !== insider && p !== imposter) await btn(p, "Reveal my card").click();
  await p.page.getByRole("button", { name: "Hide my card" }).click();
  await btn(p, "I’m ready").click();
}
await all((s) => s.phase === "clues");
const speaker = players.find(
  (p) => p.state.me.id === host.state.turn.currentId,
);
await shot(speaker, "4-clue-speaker");
await shot(
  players.find((p) => p !== speaker),
  "4-clue-listener",
);
for (let i = 0; i < 4; i++) {
  const cur = players.find((p) => p.state.me.id === host.state.turn.currentId);
  const turnId = host.state.turn.id;
  await btn(cur, "Done with my clue").click();
  await all((s) => s.phase === "discussion" || s.turn?.id !== turnId);
}
await all((s) => s.phase === "discussion");
await shot(host, "5-discussion");
await btn(host, "Start private voting").click();
await all((s) => s.phase === "voting");
const voter = players.find((p) => p !== imposter);
await voter.page.locator(`[data-vote="${imposter.state.me.id}"]`).click();
await shot(voter, "6-voting");
for (const p of players) {
  const choice = p === imposter ? insider.state.me.id : imposter.state.me.id;
  await p.page.locator(`[data-vote="${choice}"]`).click();
  await btn(p, "Lock in my vote").click();
}
await all((s) => s.phase === "guess");
await shot(imposter, "7-guess");
await imposter.page.getByLabel("Your final guess").fill("pretzel");
await btn(imposter, "Submit final guess").click();
await all((s) => s.phase === "results");
await shot(host, "8-results");
console.log(headings.join("\n"));
console.log(
  errors.length
    ? `PROBLEMS:\n${errors.join("\n")}`
    : `captured to ${out}, no page errors or overflow`,
);
await browser.close();
await server.close?.();
process.exit(errors.length ? 1 : 0);
