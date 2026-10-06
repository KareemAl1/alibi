// Ten-player phone review: fills a room to the 10-player maximum, then on a
// 390x844 phone viewport screenshots the lobby and vote screens and scrolls the
// vote screen top to bottom, recording any scroll position where the fixed
// action dock overlaps a suspect tile.
//
//   BROWSER_PATH=/path/to/chromium node design/crowd.mjs --out artifacts/design/crowd
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createAlibiServer } from "../server/index.js";

const i = process.argv.indexOf("--out");
const out = i > -1 ? process.argv[i + 1] : "artifacts/design/crowd";
await mkdir(out, { recursive: true });
const server = await createAlibiServer();
const base = `http://127.0.0.1:${await server.listen()}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_PATH
    ? { executablePath: process.env.BROWSER_PATH }
    : {}),
});
const names = [
  "Kareem",
  "Maya",
  "Dre",
  "Lina",
  "Josephine",
  "Theo",
  "Priya",
  "Marcus",
  "Anastasia Wolfington",
  "Wes",
];
const players = [];
const errors = [];
async function open(nick, phone) {
  const context = await browser.newContext({
    viewport: phone
      ? { width: 390, height: 844 }
      : { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
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
  await page.goto(base);
  await expect(page.locator("#connection")).toContainText("Connected");
  players.push(p);
  return p;
}
const btn = (p, name) => p.page.getByRole("button", { name, exact: true });
const until = (p, f) =>
  expect
    .poll(() => Boolean(p.state && f(p.state)), { timeout: 20000 })
    .toBe(true);
const all = (f) => Promise.all(players.map((p) => until(p, f)));
const settle = (page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((img) => img.decode().catch(() => {})),
    );
  });

// The phone player is the host so the lobby shows the host's dock too.
const host = await open(names[0], true);
await host.page.getByLabel("What should we call you?").fill(host.nick);
await btn(host, "Create a private room").click();
await until(host, (s) => s.code);
const code = host.state.code;
for (const [n, nick] of names.slice(1).entries()) {
  const p = await open(nick, false);
  await btn(p, "Join a room").click();
  await p.page.getByLabel("Room code").fill(code);
  await p.page.getByLabel("What should we call you?").fill(nick);
  await p.page.locator(`[data-avatar="${(n + 1) % 8}"]`).click();
  await btn(p, "Join the room").click();
  await until(p, (s) => s.code === code);
}
await all((s) => s.players.filter((x) => x.connected).length === 10);
await settle(host.page);
await host.page.screenshot({
  path: `${out}/lobby-10-phone.png`,
  fullPage: true,
});

await btn(host, "Start the round").click();
await all((s) => s.phase === "reveal");
for (const p of players) {
  await btn(p, "Reveal my card").click();
  await p.page.getByRole("button", { name: "Hide my card" }).click();
  await btn(p, "I’m ready").click();
}
await all((s) => s.phase === "clues");
for (let n = 0; n < 10; n++) {
  const cur = players.find((p) => p.state.me.id === host.state.turn.currentId);
  const turnId = host.state.turn.id;
  await btn(cur, "Done with my clue").click();
  await all((s) => s.phase === "discussion" || s.turn?.id !== turnId);
}
await all((s) => s.phase === "discussion");
await btn(host, "Start private voting").click();
await all((s) => s.phase === "voting");
await settle(host.page);
await host.page.screenshot({
  path: `${out}/vote-10-phone.png`,
  fullPage: true,
});

// Scroll the whole vote screen in 20px steps and look for overlap.
const report = await host.page.evaluate(async () => {
  const dock = document.querySelector(".action-dock");
  const tiles = [...document.querySelectorAll(".vote-candidate")];
  const max = document.documentElement.scrollHeight - innerHeight;
  const overlaps = [];
  for (let y = 0; y <= max + 20; y += 20) {
    scrollTo(0, Math.min(y, max));
    await new Promise((r) => requestAnimationFrame(r));
    const d =
      dock && getComputedStyle(dock).display !== "none"
        ? dock.getBoundingClientRect()
        : null;
    if (!d) continue;
    tiles.forEach((t, index) => {
      const r = t.getBoundingClientRect();
      if (
        r.bottom > d.top &&
        r.top < d.bottom &&
        r.bottom > 0 &&
        r.top < innerHeight
      )
        overlaps.push({
          scrollY: scrollY,
          tile: index,
          name: t.querySelector("b")?.textContent,
        });
    });
  }
  const button = document.querySelector("[data-submit-vote]");
  const grid = document.querySelector(".vote-grid").getBoundingClientRect();
  return {
    tiles: tiles.length,
    columns: getComputedStyle(
      document.querySelector(".vote-grid"),
    ).gridTemplateColumns.split(" ").length,
    pageHeight: document.documentElement.scrollHeight,
    gridHeight: Math.round(grid.height),
    dockPresent: Boolean(dock),
    overlapPositions: new Set(overlaps.map((o) => o.scrollY)).size,
    overlappedSuspects: [...new Set(overlaps.map((o) => o.name))],
    lockButtonInDock: Boolean(button?.closest(".action-dock")),
    overflowX: document.documentElement.scrollWidth > innerWidth,
  };
});

// Narrowest supported phone: no sideways scroll with a 20-character name.
await host.page.setViewportSize({ width: 320, height: 700 });
report.overflowXAt320 = await host.page.evaluate(
  () => document.documentElement.scrollWidth > innerWidth,
);
await host.page.screenshot({ path: `${out}/vote-10-320.png`, fullPage: true });
await host.page.setViewportSize({ width: 390, height: 844 });

// The vote still works from the phone: pick the first open suspect and lock.
const target = host.page.locator(".vote-candidate:not(:disabled)").first();
await target.scrollIntoViewIfNeeded();
await target.click();
const lock = btn(host, "Lock in my vote");
await lock.scrollIntoViewIfNeeded();
const box = await lock.boundingBox();
report.lockButtonVisibleAfterScroll =
  box && box.y >= 0 && box.y + box.height <= 844;
await lock.click();
await until(host, (s) => s.me.hasVoted);
report.voteLockedFromPhone = true;
report.pageErrors = errors;
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(0);
