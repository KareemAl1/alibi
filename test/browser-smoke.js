import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { createAlibiServer } from "../server/index.js";

// Real UI operations in independent cookie jars. No test-only game endpoints.
const server = await createAlibiServer();
const port = await server.listen();
const base = `http://127.0.0.1:${port}`;
await mkdir("artifacts", { recursive: true });
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || "chrome",
  headless: true,
});
const clients = [],
  errors = [];
const wait = async (client, predicate) =>
  expect
    .poll(() => Boolean(predicate(client.state)), { timeout: 12_000 })
    .toBe(true);
const phase = (client, value) =>
  wait(client, (state) => state?.phase === value);
const click = (client, text) =>
  client.page.getByRole("button", { name: text, exact: true }).click();
const host = () => clients.find((c) => c.state?.me.isHost);

async function client(nickname, width = 1280) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  // Exercise the local-network HTTP path where randomUUID is unavailable.
  await context.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined });
  });
  const page = await context.newPage();
  const result = {
    context,
    page,
    nickname,
    state: null,
    frames: [],
    histories: [],
  };
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (ws) =>
    ws.on("framereceived", (event) => {
      const payload = event.payload.toString();
      if (!payload.startsWith("42")) return;
      const [type, value] = JSON.parse(payload.slice(2));
      result.frames.push({ type, value, raw: payload });
      if (type === "state") {
        result.state = value;
        result.histories.push(value);
      }
    }),
  );
  await page.goto(base);
  await expect(page.locator("#connection")).toHaveText(
    "Connected · let’s play",
  );
  clients.push(result);
  return result;
}

async function join(c, code) {
  await click(c, "Join a room");
  await c.page.getByLabel("What should we call you?").fill(c.nickname);
  await c.page.getByLabel("Room code").fill(code);
  await c.page.locator(`[data-avatar="${clients.indexOf(c) % 8}"]`).click();
  await expect(
    c.page.locator(`[data-avatar="${clients.indexOf(c) % 8}"]`),
  ).toBeFocused();
  await click(c, "Join the room");
  await wait(c, (state) => state?.code === code);
}

async function startRound() {
  await click(
    host(),
    host().state.phase === "results" ? "Next round" : "Start the round",
  );
  for (const c of clients) {
    await phase(c, "reveal");
    await expect(
      c.page.getByRole("button", { name: "Reveal my card", exact: true }),
    ).toBeVisible();
    await expect(c.page.locator(".role-content")).toHaveCount(0);
    await click(c, "Reveal my card");
    await expect(c.page.locator(".role-content")).toBeVisible();
    await expect(
      c.page.getByRole("button", { name: "Hide my card" }),
    ).toBeFocused();
    await click(c, "Hide my card");
    await click(c, "I’m ready");
  }
  await Promise.all(clients.map((c) => phase(c, "clues")));
}

async function lap() {
  for (let i = 0; i < clients.length; i++) {
    const currentId = clients[0].state.turn.currentId;
    const current = clients.find((c) => c.state.me.id === currentId);
    await expect(
      current.page.getByRole("heading", { name: "Your turn.", exact: true }),
    ).toBeVisible();
    const oldTurn = current.state.turn.id;
    await click(current, "Done with my clue");
    await Promise.all(
      clients.map((c) =>
        wait(
          c,
          (state) => state.phase === "discussion" || state.turn?.id !== oldTurn,
        ),
      ),
    );
  }
  await Promise.all(clients.map((c) => phase(c, "discussion")));
}

async function voteFor(target) {
  const chosen = clients.find((c) => c.state.me.id === target);
  for (const c of clients) {
    const targetClient =
      c === chosen ? clients.find((other) => other !== c) : chosen;
    await c.page.locator(`[data-vote="${targetClient.state.me.id}"]`).click();
    await click(c, "Lock in my vote");
  }
}

function checkPrivacy(c, secret, roundId) {
  const snapshots = c.histories.filter(
    (s) => s?.roundId === roundId && s.phase !== "results",
  );
  expect(snapshots.length).toBeGreaterThan(0);
  for (const snapshot of snapshots) {
    expect(snapshot.me.word).toBeUndefined();
    expect(JSON.stringify(snapshot).toLowerCase()).not.toContain(
      `"${secret.toLowerCase()}"`,
    );
    if (snapshot.voting) {
      expect(snapshot.voting.votes).toBeUndefined();
      expect(snapshot.voting.totals).toBeUndefined();
    }
  }
}

try {
  const a = await client("Sam");
  await a.page.screenshot({
    path: "artifacts/entry-desktop.png",
    fullPage: true,
  });
  await a.page.getByLabel("What should we call you?").fill("Sam");
  await click(a, "Create a private room");
  await phase(a, "lobby");
  const code = a.state.code;
  for (const [nickname, width] of [
    ["Alex", 1280],
    ["Jamie", 390],
    ["Riley", 1280],
  ])
    await join(await client(nickname, width), code);
  await Promise.all(clients.map((c) => wait(c, (s) => s.players.length === 4)));
  await a.page.screenshot({
    path: "artifacts/lobby-desktop.png",
    fullPage: true,
  });
  await clients[2].page.screenshot({
    path: "artifacts/lobby-mobile.png",
    fullPage: true,
  });
  console.log(
    "PASS: four independent browser sessions created and joined a synchronized room.",
  );

  for (const outcome of ["innocent", "incorrect", "correct", "tie"]) {
    await startRound();
    const imposter = clients.find((c) => c.state.me.role === "imposter");
    const insider = clients.find((c) => c.state.me.role === "insider");
    const secret = insider.state.me.word,
      roundId = insider.state.roundId;
    if (outcome === "innocent") {
      await clients[2].page.screenshot({
        path: "artifacts/clues-mobile.png",
        fullPage: true,
      });
      await a.page.screenshot({
        path: "artifacts/clues-desktop.png",
        fullPage: true,
      });
      await click(host(), "Pause round");
      await Promise.all(clients.map((c) => wait(c, (s) => s.turn.paused)));
      const current = clients.find(
        (c) => c.state.me.id === c.state.turn.currentId,
      );
      await expect(
        current.page.getByRole("button", { name: "Done with my clue" }),
      ).toBeDisabled();
      await click(host(), "Resume round");
      await Promise.all(clients.map((c) => wait(c, (s) => !s.turn.paused)));
      // The refreshed player keeps the same cookie-bound private role.
      const prior = { id: imposter.state.me.id, role: imposter.state.me.role };
      const oldHistoryLength = imposter.histories.length;
      await imposter.page.reload();
      await wait(
        imposter,
        (s) =>
          s?.me.id === prior.id &&
          s.me.role === prior.role &&
          imposter.histories.length > oldHistoryLength,
      );
      await expect(
        imposter.page.getByRole("button", { name: "Reveal my card" }),
      ).toBeVisible();
      console.log(
        "PASS: pause/resume and refresh restore private role with card concealed.",
      );
    }
    await lap();
    if (outcome === "innocent") {
      await click(host(), "One more clue lap");
      await Promise.all(clients.map((c) => phase(c, "clues")));
      await lap();
      await expect(
        host().page.getByRole("button", { name: "One more clue lap" }),
      ).toHaveCount(0);
    }
    await click(host(), "Start private voting");
    await Promise.all(clients.map((c) => phase(c, "voting")));
    if (outcome === "tie") {
      for (const c of clients) {
        const index = clients.indexOf(c),
          target = clients[index % 2 === 0 ? index + 1 : index - 1];
        await c.page.locator(`[data-vote="${target.state.me.id}"]`).click();
        await click(c, "Lock in my vote");
      }
      await Promise.all(clients.map((c) => phase(c, "runoff")));
      for (const c of clients) {
        const index = clients.indexOf(c),
          target = clients[index % 2 === 0 ? index + 1 : index - 1];
        await c.page.locator(`[data-vote="${target.state.me.id}"]`).click();
        await click(c, "Lock in my vote");
      }
    } else {
      await voteFor((outcome === "innocent" ? insider : imposter).state.me.id);
      if (outcome !== "innocent") {
        await Promise.all(clients.map((c) => phase(c, "guess")));
        await expect(
          imposter.page.getByLabel("Your final guess"),
        ).toBeVisible();
        await imposter.page
          .getByLabel("Your final guess")
          .fill(
            outcome === "correct"
              ? `  ${secret.toUpperCase()}!!!  `
              : "definitely the wrong thing",
          );
        await click(imposter, "Submit final guess");
      }
    }
    await Promise.all(clients.map((c) => phase(c, "results")));
    const expected = outcome === "incorrect" ? "group" : "imposter";
    for (const c of clients) expect(c.state.result.winner).toBe(expected);
    checkPrivacy(imposter, secret, roundId);
    if (outcome === "incorrect")
      await a.page.screenshot({
        path: "artifacts/results-desktop.png",
        fullPage: true,
      });
    console.log(
      `PASS: UI round ${outcome}; all four clients agree, imposter snapshots contain no word before reveal.`,
    );
    if (outcome === "innocent") {
      const owner = host();
      await owner.page.locator(".next-categories summary").click();
      const categories = await owner.page
        .locator('input[name="category"]')
        .evaluateAll((items) => items.map((el) => el.value));
      for (const category of categories) {
        await owner.page.locator(`input[value="${category}"]`).uncheck();
        await wait(owner, (s) => !s.categories.includes(category));
        await expect(owner.page.locator(".next-categories")).toHaveAttribute(
          "open",
          "",
        );
        await expect(
          owner.page.locator(`input[value="${category}"]`),
        ).toBeFocused();
      }
      await expect(
        owner.page.getByRole("button", { name: "Next round" }),
      ).toBeDisabled();
      await owner.page.locator(`input[value="${categories[0]}"]`).check();
      await wait(owner, (s) => s.categories.length === 1);
      console.log(
        "PASS: category details and keyboard focus survive synchronized updates; empty pool cannot start.",
      );
    }
  }

  await startRound();
  const late = await client("Morgan", 390);
  await join(late, code);
  await expect(
    late.page.getByText(
      "You joined during a round. Your seat is saved for the next one.",
    ),
  ).toBeVisible();
  expect(late.state.me.role).toBeUndefined();
  expect(late.state.me.word).toBeUndefined();
  expect(late.state.me.category).toBeUndefined();
  await expect(
    late.page.getByRole("button", { name: "Reveal my card" }),
  ).toHaveCount(0);
  console.log("PASS: late browser arrival waits without receiving secrets.");
  const departing = host(),
    departingId = departing.state.me.id;
  await click(departing, "Leave room");
  await wait(departing, (s) => s === null);
  const remaining = clients.filter((c) => c !== departing);
  await Promise.all(remaining.map((c) => phase(c, "results")));
  for (const c of remaining) {
    expect(c.state.result.winner).toBeNull();
    expect(c.state.hostId).not.toBe(departingId);
  }
  console.log(
    "PASS: explicit host departure transfers control and abandons round visibly.",
  );

  // Mobile layout and keyboard-accessible control sanity checks.
  for (const c of clients) {
    expect(
      await c.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await departing.page.setViewportSize({ width: 390, height: 844 });
  await departing.page.screenshot({
    path: "artifacts/entry-mobile.png",
    fullPage: true,
  });
  await departing.page.keyboard.press("Tab");
  expect(
    await departing.page.evaluate(() => document.activeElement.tagName),
  ).not.toBe("BODY");
  await departing.page.setViewportSize({ width: 320, height: 700 });
  expect(
    await departing.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  console.log(
    "PASS: desktop/mobile layouts have no horizontal overflow; keyboard focus works; no browser JS errors.",
  );
} finally {
  await browser.close();
  await server.close();
}
