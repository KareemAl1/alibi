import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAlibiServer } from "../server/index.js";

// Real UI operations in independent cookie jars. No test-only game endpoints.
const server = await createAlibiServer();
const port = await server.listen();
const base = `http://127.0.0.1:${port}`;
const output = process.env.BROWSER_ARTIFACT_DIR || "artifacts/review";
await mkdir(output, { recursive: true });
// BROWSER_PATH points at a specific Chromium build (e.g. in CI or a sandbox);
// otherwise use the installed browser channel.
const browser = await chromium.launch({
  ...(process.env.BROWSER_PATH
    ? { executablePath: process.env.BROWSER_PATH }
    : { channel: process.env.BROWSER_CHANNEL || "chrome" }),
  headless: true,
});
const clients = [],
  errors = [],
  checks = [],
  layouts = [],
  usedWords = new Set();
const startedAt = new Date().toISOString();
const record = (message) => {
  checks.push(message);
  console.log(`PASS: ${message}`);
};
const wait = async (client, predicate, timeout = 12_000) =>
  expect.poll(() => Boolean(predicate(client.state)), { timeout }).toBe(true);
const phase = (client, value) =>
  wait(client, (state) => state?.phase === value);
const click = (client, text) =>
  client.page.getByRole("button", { name: text, exact: true }).click();
const host = () =>
  clients.find((c) => c.state?.me.isHost && !c.page.isClosed());

async function synchronized(expected, group = clients) {
  await Promise.all(group.map((c) => phase(c, expected)));
  await expect
    .poll(
      () =>
        new Set(
          group.map((c) => {
            const { me, ...shared } = c.state;
            return JSON.stringify(shared);
          }),
        ).size,
    )
    .toBe(1);
}

function observePage(result, page) {
  result.page = page;
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
}

async function capturePair(c, name, action) {
  const initial = c.page.viewportSize();
  for (const [suffix, width, height] of [
    ["", 1280, 900],
    ["-mobile", 390, 844],
  ]) {
    await c.page.setViewportSize({ width, height });
    await c.page.evaluate(() => scrollTo(0, 0));
    expect(
      await c.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await c.page.screenshot({
      path: path.join(output, `${name}${suffix}.png`),
      fullPage: true,
    });
    if (action && width === 390) {
      const control = c.page.getByRole("button", { name: action, exact: true });
      await expect(control).toBeVisible();
      const initialBounds = await control.boundingBox();
      await control.scrollIntoViewIfNeeded();
      const bounds = await control.boundingBox();
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
      layouts.push({
        screen: name,
        viewport: { width, height },
        action,
        visibleFromTop:
          initialBounds.y >= 0 &&
          initialBounds.y + initialBounds.height <= height,
        boundsAfterScroll: bounds,
      });
      await c.page.screenshot({
        path: path.join(output, `${name}-mobile-action.png`),
      });
    }
  }
  await c.page.setViewportSize({ width: 320, height: 700 });
  expect(
    await c.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await c.page.setViewportSize(initial);
  await c.page.evaluate(() => scrollTo(0, 0));
}

async function client(nickname, width = 1280) {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
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
  observePage(result, page);
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
  const owner = host();
  const priorRound = owner.state.roundId;
  const priorViewport = owner.page.viewportSize();
  if (priorRound > 0)
    await owner.page.setViewportSize({ width: 390, height: 844 });
  await click(
    host(),
    host().state.phase === "results" ? "Next round" : "Start the round",
  );
  await synchronized("reveal");
  if (priorRound > 0) await owner.page.setViewportSize(priorViewport);
  expect(clients[0].state.roundId).toBe(priorRound + 1);
  const imposters = clients.filter((c) => c.state.me.role === "imposter");
  const insiders = clients.filter((c) => c.state.me.role === "insider");
  expect(imposters).toHaveLength(1);
  expect(insiders).toHaveLength(3);
  const secret = insiders[0].state.me.word;
  expect(new Set(insiders.map((c) => c.state.me.word)).size).toBe(1);
  expect(imposters[0].state.me.word).toBeUndefined();
  expect(usedWords.has(secret)).toBe(false);
  usedWords.add(secret);
  for (const [index, c] of clients.entries()) {
    await phase(c, "reveal");
    await expect(
      c.page.getByRole("button", { name: "Reveal my card", exact: true }),
    ).toBeVisible();
    await expect(c.page.locator(".role-content")).toHaveCount(0);
    await click(c, "Reveal my card");
    await expect(c.page.locator(".role-content")).toBeVisible();
    if (c.state.me.role === "imposter")
      await expect(c.page.locator(".role-content")).not.toContainText(secret);
    else await expect(c.page.locator(".role-content h2")).toHaveText(secret);
    await expect(
      c.page.getByRole("button", { name: "Hide my card" }),
    ).toBeFocused();
    await click(c, "Hide my card");
    await click(c, "I’m ready");
    if (index < clients.length - 1) {
      await synchronized("reveal");
      await Promise.all(
        clients.map((other) =>
          wait(
            other,
            (s) => s.players.filter((p) => p.ready).length === index + 1,
          ),
        ),
      );
      await expect(
        c.page.getByRole("button", { name: "You’re ready" }),
      ).toBeDisabled();
    }
  }
  await synchronized("clues");
}

async function lap() {
  const spoken = new Set();
  for (let i = 0; i < clients.length; i++) {
    await synchronized("clues");
    const currentId = clients[0].state.turn.currentId;
    const current = clients.find((c) => c.state.me.id === currentId);
    expect(spoken.has(currentId)).toBe(false);
    spoken.add(currentId);
    for (const c of clients) {
      await expect(c.page.locator(".turn-row.current")).toContainText(
        current.nickname,
      );
      const done = c.page.getByRole("button", {
        name: "Done with my clue",
        exact: true,
      });
      if (c === current) await expect(done).toBeEnabled();
      else await expect(done).toHaveCount(0);
    }
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
  expect(spoken.size).toBe(4);
  await synchronized("discussion");
}

async function castVote(c, targetId, expectedCount) {
  const priorBallots = c.state.ballots.length;
  const votingPhase = c.state.phase;
  await expect(c.page.locator(`[data-vote="${c.state.me.id}"]`)).toBeDisabled();
  await c.page.locator(`[data-vote="${targetId}"]`).click();
  await click(c, "Lock in my vote");
  if (expectedCount < clients.length) {
    await synchronized(votingPhase);
    await Promise.all(
      clients.map((other) =>
        wait(other, (s) => s.voting.submitted === expectedCount),
      ),
    );
    for (const other of clients) {
      expect(other.state.ballots).toHaveLength(priorBallots);
      expect(other.state.voting.votes).toBeUndefined();
      expect(other.state.voting.totals).toBeUndefined();
      expect(other.state.voting.targetId).toBeUndefined();
    }
    await expect(
      c.page.getByRole("button", { name: "Vote locked", exact: true }),
    ).toBeDisabled();
  }
}

async function voteFor(target) {
  const chosen = clients.find((c) => c.state.me.id === target);
  for (const [index, c] of clients.entries()) {
    const targetClient =
      c === chosen ? clients.find((other) => other !== c) : chosen;
    await castVote(c, targetClient.state.me.id, index + 1);
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

async function reconnectChecks() {
  const owner = host();
  const visitor = clients.find((c) => c !== owner);
  const prior = { ...visitor.state.me };
  const priorRound = visitor.state.roundId;
  const priorTurn = visitor.state.turn.id;
  const others = clients.filter((c) => c !== visitor);
  await click(visitor, "Reveal my card");
  await visitor.context.setOffline(true);
  await expect(visitor.page.locator("#connection")).toHaveText(
    "Reconnecting…",
    { timeout: 25_000 },
  );
  await expect(visitor.page.locator(".role-content")).toHaveCount(0);
  await expect(visitor.page.locator("[data-action]:enabled")).toHaveCount(0);
  await Promise.all(
    others.map((c) =>
      wait(
        c,
        (s) => s.players.find((p) => p.id === prior.id)?.connected === false,
        25_000,
      ),
    ),
  );
  await expect(others[0].page.locator(".notice.warning")).toContainText(
    `${visitor.nickname} is reconnecting`,
  );
  await visitor.context.setOffline(false);
  await expect(visitor.page.locator("#connection")).toHaveText(
    "Connected · let’s play",
    { timeout: 25_000 },
  );
  await synchronized("clues");
  expect(visitor.state.me).toEqual(prior);
  expect(visitor.state.roundId).toBe(priorRound);
  expect(visitor.state.turn.id).toBe(priorTurn);
  await expect(
    visitor.page.getByRole("button", { name: "Reveal my card", exact: true }),
  ).toBeVisible();
  record(
    "Chrome offline/online reconnect restores the same player, private role and turn; card re-conceals and peers see reconnection.",
  );

  const formerId = owner.state.me.id;
  const formerRole = owner.state.me.role;
  const formerWord = owner.state.me.word;
  const peers = clients.filter((c) => c !== owner);
  await owner.page.close();
  await Promise.all(
    peers.map((c) =>
      wait(
        c,
        (s) =>
          s.hostId !== formerId &&
          !s.players.find((p) => p.id === formerId).connected,
      ),
    ),
  );
  await synchronized("clues", peers);
  const replacementId = peers[0].state.hostId;
  const replacement = peers.find((c) => c.state.me.id === replacementId);
  await expect(
    replacement.page.getByRole("button", { name: "Pause round", exact: true }),
  ).toBeVisible();
  observePage(owner, await owner.context.newPage());
  await owner.page.goto(`${base}/?room=${peers[0].state.code}`);
  await expect(owner.page.locator("#connection")).toHaveText(
    "Connected · let’s play",
  );
  await synchronized("clues");
  expect(owner.state.me.id).toBe(formerId);
  expect(owner.state.me.role).toBe(formerRole);
  expect(owner.state.me.word).toBe(formerWord);
  expect(owner.state.hostId).toBe(replacementId);
  expect(owner.state.me.isHost).toBe(false);
  await expect(owner.page.locator(".role-content")).toHaveCount(0);
  record(
    "Closing the host tab transfers controls; reopening during seat grace restores identity/role and keeps the replacement host.",
  );
}

let failure;
try {
  const a = await client("Sam");
  await capturePair(a, "entry", "Create a private room");
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
  await synchronized("lobby");
  expect(new Set(clients.map((c) => c.state.me.id)).size).toBe(4);
  const cookies = await Promise.all(clients.map((c) => c.context.cookies()));
  expect(
    new Set(
      cookies.map(
        (items) => items.find((c) => c.name === "alibi_session").value,
      ),
    ).size,
  ).toBe(4);
  await capturePair(a, "lobby", "Start the round");
  record(
    "Four independent Chrome cookie jars joined one synchronized room; each player/session is distinct.",
  );

  for (const outcome of ["innocent", "incorrect", "correct", "tie"]) {
    await startRound();
    const imposter = clients.find((c) => c.state.me.role === "imposter");
    const insider = clients.find((c) => c.state.me.role === "insider");
    const secret = insider.state.me.word,
      roundId = insider.state.roundId;
    if (outcome === "innocent") {
      const speaker = clients.find(
        (c) => c.state.me.id === c.state.turn.currentId,
      );
      await capturePair(speaker, "active-turn", "Done with my clue");
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
      record(
        "Pause/resume synchronizes; refresh restores the same private role with card concealed.",
      );
      await reconnectChecks();
    }
    await lap();
    if (outcome === "innocent") {
      await capturePair(host(), "discussion", "Start private voting");
      await click(host(), "One more clue lap");
      await Promise.all(clients.map((c) => phase(c, "clues")));
      await lap();
      await expect(
        host().page.getByRole("button", { name: "One more clue lap" }),
      ).toHaveCount(0);
    }
    await click(host(), "Start private voting");
    await synchronized("voting");
    if (outcome === "incorrect") {
      const voter = clients.find((c) => c !== imposter);
      await voter.page.locator(`[data-vote="${imposter.state.me.id}"]`).click();
      await capturePair(voter, "voting", "Lock in my vote");
    }
    if (outcome === "tie") {
      for (const c of clients) {
        const index = clients.indexOf(c),
          target = clients[index % 2 === 0 ? index + 1 : index - 1];
        await castVote(c, target.state.me.id, index + 1);
      }
      await synchronized("runoff");
      expect(clients[0].state.ballots).toHaveLength(1);
      for (const c of clients) {
        const index = clients.indexOf(c),
          target = clients[index % 2 === 0 ? index + 1 : index - 1];
        await castVote(c, target.state.me.id, index + 1);
      }
    } else {
      await voteFor((outcome === "innocent" ? insider : imposter).state.me.id);
      if (outcome !== "innocent") {
        await synchronized("guess");
        for (const c of clients) {
          const input = c.page.getByLabel("Your final guess");
          if (c === imposter) await expect(input).toBeVisible();
          else await expect(input).toHaveCount(0);
        }
        if (outcome === "incorrect")
          await capturePair(imposter, "final-guess", "Submit final guess");
        const guessViewport = imposter.page.viewportSize();
        await imposter.page.setViewportSize({ width: 390, height: 844 });
        await expect(
          imposter.page
            .locator(".action-dock")
            .getByRole("button", { name: "Submit final guess", exact: true }),
        ).toBeVisible();
        await imposter.page
          .getByLabel("Your final guess")
          .fill(
            outcome === "correct"
              ? `  ${secret.toUpperCase()}!!!  `
              : "definitely the wrong thing",
          );
        await click(imposter, "Submit final guess");
        await phase(imposter, "results");
        await imposter.page.setViewportSize(guessViewport);
      }
    }
    await synchronized("results");
    const expected = outcome === "incorrect" ? "group" : "imposter";
    for (const c of clients) {
      expect(c.state.result.winner).toBe(expected);
      expect(c.state.result.word).toBe(secret);
      await expect(c.page.locator(".result-card h2")).toHaveText(secret);
    }
    checkPrivacy(imposter, secret, roundId);
    if (outcome === "incorrect")
      await capturePair(host(), "results", "Next round");
    record(
      `Complete UI round ${outcome}: reveal/readiness, all four speaking turns, discussion, private partial ballots, ${outcome === "tie" ? "tied runoff" : outcome === "innocent" ? "innocent accusation" : "imposter-only final guess"}, synchronized results; no word in imposter payloads before results.`,
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
      record(
        "Category details/focus survive updates; empty categories disable rematch.",
      );
    }
  }

  record(
    "Three complete rematches re-deal exactly one imposter/three insiders, conceal previous cards and use a fresh secret; rematch and both final guesses were submitted using the phone action dock.",
  );
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
  record(
    "A fifth late-arriving browser waits without receiving a role, category or secret.",
  );
  const departing = host(),
    departingId = departing.state.me.id;
  await click(departing, "Leave room");
  await wait(departing, (s) => s === null);
  const remaining = clients.filter((c) => c !== departing);
  await synchronized("results", remaining);
  for (const c of remaining) {
    expect(c.state.result.winner).toBeNull();
    expect(c.state.hostId).not.toBe(departingId);
    await expect(
      c.page.getByRole("heading", { name: "Case interrupted.", exact: true }),
    ).toBeVisible();
  }
  record(
    "Explicit host Leave room transfers control, visibly abandons the active round and gives no winner.",
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
    path: path.join(output, "entry-mobile.png"),
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
  record(
    "1280px desktop and 390px/320px responsive layouts have no horizontal overflow; measured main actions are at least 44px and reachable by scrolling; keyboard focus works; no browser JavaScript errors.",
  );
} catch (error) {
  failure = error;
  throw error;
} finally {
  await writeFile(
    path.join(output, "browser-report.json"),
    JSON.stringify(
      {
        passed: !failure,
        startedAt,
        finishedAt: new Date().toISOString(),
        browser: `Chrome ${browser.version()}`,
        headless: true,
        method:
          "Playwright-driven real Chrome BrowserContexts, independent cookies, UI mutations and passive network observation",
        checks,
        layouts,
        errors,
        failure: failure?.message,
        unverified: [
          "Physical iOS/Android devices",
          "Safari/Firefox",
          "Physical mobile OS suspension/background-tab lifecycle (headless tabs remain visible)",
          "Actual voice-call quality",
          "Public HTTPS/proxy hosting",
          "Full seat-grace expiration in a browser (separate server tests cover it)",
        ],
      },
      null,
      2,
    ),
  );
  await browser.close();
  await server.close();
}
