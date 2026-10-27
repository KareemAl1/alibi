// Plays one full round against a deployed Alibi with four independent
// sessions (one at phone size) and checks the things only a real deploy can
// show: secure WebSocket transport, Secure cookies, refresh recovery, and that
// the imposter never receives the word before results.
//
//   BROWSER_PATH=... node design/live-check.mjs https://your-alibi.onrender.com
import { chromium, expect } from "@playwright/test";

const base = (process.argv[2] || "").replace(/\/+$/, "");
if (!base.startsWith("https://")) throw new Error("Pass the https:// address.");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_PATH
    ? { executablePath: process.env.BROWSER_PATH }
    : {}),
});
const results = [];
const ok = (label, pass, detail = "") =>
  results.push({ check: label, result: pass ? "pass" : "FAIL", detail });
const players = [];
async function open(nick, phone) {
  const context = await browser.newContext(
    phone
      ? {
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
        }
      : {},
  );
  const page = await context.newPage();
  const p = {
    nick,
    context,
    page,
    state: null,
    frames: [],
    sockets: [],
    errors: [],
  };
  page.on("pageerror", (e) => p.errors.push(e.message));
  page.on("websocket", (ws) => {
    p.sockets.push(ws.url());
    ws.on("framereceived", (ev) => {
      const s = ev.payload.toString();
      if (!s.startsWith("42")) return;
      const [t, v] = JSON.parse(s.slice(2));
      if (t === "state") {
        p.state = v;
        p.frames.push(s);
      }
    });
  });
  await page.goto(base);
  await expect(page.locator("#connection")).toContainText("Connected", {
    timeout: 30000,
  });
  players.push(p);
  return p;
}
const btn = (page, name) => page.getByRole("button", { name, exact: true });
const until = (p, f, timeout = 30000) =>
  expect.poll(() => Boolean(p.state && f(p.state)), { timeout }).toBe(true);
const all = (f) => Promise.all(players.map((p) => until(p, f)));
const t0 = Date.now();

const host = await open("Kareem", false);
await host.page.getByLabel("What should we call you?").fill("Host");
await btn(host.page, "Create a private room").click();
await until(host, (s) => s.code);
const code = host.state.code;
for (const [i, nick] of ["Phone", "Desk", "Late"].entries()) {
  const p = await open(nick, i === 0);
  await p.page.goto(`${base}/?room=${code}`);
  await expect(p.page.locator("#connection")).toContainText("Connected", {
    timeout: 30000,
  });
  await p.page.getByLabel("What should we call you?").fill(nick);
  await btn(p.page, "Join the room").click();
  await until(p, (s) => s.code === code);
}
await all((s) => s.players.filter((x) => x.connected).length === 4);
ok("4 sessions joined one room (3 by invite link)", true, code);
const cookies = await Promise.all(players.map((p) => p.context.cookies()));
const sess = cookies.map((c) => c.find((x) => x.name === "alibi_session"));
ok(
  "session cookies are Secure, HttpOnly, SameSite=Lax, all distinct",
  sess.every((c) => c && c.secure && c.httpOnly && c.sameSite === "Lax") &&
    new Set(sess.map((c) => c.value)).size === 4,
);
const wsUrls = players.flatMap((p) => p.sockets);
ok(
  "game traffic runs over secure WebSockets (wss)",
  wsUrls.length >= 4 && wsUrls.every((u) => u.startsWith("wss://")),
  wsUrls[0]?.replace(/sid=[^&]+/, "sid=…"),
);

await btn(host.page, "Start the round").click();
await all((s) => s.phase === "reveal");
const imposter = players.find((p) => p.state.me.role === "imposter");
const word = players.find((p) => p.state.me.role === "insider").state.me.word;
for (const p of players) {
  await btn(p.page, "Reveal my card").click();
  await p.page.getByRole("button", { name: "Hide my card" }).click();
  await btn(p.page, "I’m ready").click();
}
await all((s) => s.phase === "clues");
// Refresh one non-host player mid-round: same seat and role must come back.
const refresher = players[2];
const before = { id: refresher.state.me.id, role: refresher.state.me.role };
await refresher.page.reload();
await expect(refresher.page.locator("#connection")).toContainText("Connected", {
  timeout: 30000,
});
await until(refresher, (s) => s.phase === "clues");
ok(
  "refresh mid-round restores the same seat and role",
  refresher.state.me.id === before.id &&
    refresher.state.me.role === before.role,
);
for (let i = 0; i < 4; i++) {
  const cur = players.find((p) => p.state.me.id === host.state.turn.currentId);
  const turn = host.state.turn.id;
  await btn(cur.page, "Done with my clue").click();
  await all((s) => s.phase === "discussion" || s.turn?.id !== turn);
}
await all((s) => s.phase === "discussion");
await btn(host.page, "Start private voting").click();
await all((s) => s.phase === "voting");
for (const p of players) {
  const target =
    p === imposter
      ? players.find((q) => q !== p).state.me.id
      : imposter.state.me.id;
  await p.page.locator(`[data-vote="${target}"]`).click();
  await btn(p.page, "Lock in my vote").click();
}
await all((s) => s.phase === "guess");
await imposter.page.getByLabel("Your final guess").fill("definitely not it");
await btn(imposter.page, "Submit final guess").click();
await all((s) => s.phase === "results");
ok(
  "full round reached results for all four: group wins, word revealed",
  players.every(
    (p) => p.state.result.winner === "group" && p.state.result.word === word,
  ),
);
const leaked = imposter.frames.filter(
  (f) =>
    !f.includes('"phase":"results"') &&
    f.toLowerCase().includes(`"${word.toLowerCase()}"`),
);
ok(
  "imposter never received the word before results",
  leaked.length === 0,
  `${imposter.frames.length} frames checked`,
);
await expect(btn(host.page, "Next round")).toBeEnabled();
ok("host can start the next round", true);
ok(
  "no page errors on any client",
  players.every((p) => !p.errors.length),
  players.flatMap((p) => p.errors).join("; "),
);
// Wrong origin is refused by the live server.
const wrong = await fetch(`${base}/api/session`, {
  method: "POST",
  headers: { Origin: "https://example.com" },
});
ok("a different site cannot create sessions", wrong.status === 403);
console.table(results);
console.log(`room ${code}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await browser.close();
process.exit(results.every((r) => r.result === "pass") ? 0 : 1);
