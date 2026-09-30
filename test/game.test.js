import test from "node:test";
import assert from "node:assert/strict";
import { GameStore, normalizeGuess } from "../server/game.js";
import { CATEGORIES, WORDS } from "../server/words.js";
import { GAME_TIMING } from "../shared/protocol.js";

function setup(count = 4, options = {}) {
  let time = 1_000;
  let serial = 0;
  const store = new GameStore({
    now: () => time,
    randomInt: () => 0,
    ...options,
  });
  const ids = Array.from({ length: count }, (_, index) => `player-${index}`);
  const room = store.create(ids[0], { nickname: "Ada", avatar: 0 });
  for (let index = 1; index < count; index++)
    store.join(ids[index], {
      code: room.code,
      nickname: `Guest ${index}`,
      avatar: index % 8,
    });
  function act(id, type, payload = {}) {
    const state = store.view(id);
    return store.act(id, {
      actionId: `action-${++serial}`,
      code: state?.code,
      roundId: state?.roundId,
      turnId: state?.turn?.id,
      votingId: state?.voting?.id,
      type,
      ...payload,
    });
  }
  const start = () => act(room.hostId, "start");
  const ready = () => {
    for (const id of room.round.participants) act(id, "ready");
  };
  const clues = () => {
    while (room.phase === "clues")
      act(room.round.order[room.round.turnIndex], "done");
  };
  const voting = () => {
    start();
    ready();
    clues();
    act(room.hostId, "vote-start");
  };
  const votes = (targets) =>
    targets.forEach((targetId, index) => act(ids[index], "vote", { targetId }));
  return {
    store,
    ids,
    room,
    act,
    start,
    ready,
    clues,
    voting,
    votes,
    tick: (milliseconds) => {
      time += milliseconds;
      store.sweep();
    },
  };
}

test("curated catalog contains 120 distinct words with valid categories and useful aliases", () => {
  assert.ok(WORDS.length >= 100);
  assert.equal(new Set(WORDS.map((word) => word.id)).size, WORDS.length);
  assert.equal(new Set(WORDS.map((word) => word.word)).size, WORDS.length);
  assert.ok(
    WORDS.every((word) =>
      CATEGORIES.some((category) => category.id === word.category),
    ),
  );
  assert.ok(WORDS.some((word) => word.accepted.includes("donut")));
  assert.equal(normalizeGuess("  HÓT - CHOCOLATE!! "), "hotchocolate");
});

test("secure room membership, valid profiles, room capacity, and host boundaries", () => {
  const game = setup(10);
  assert.throws(
    () => game.store.create(game.ids[0], { nickname: "Again", avatar: 0 }),
    /Leave/,
  );
  assert.throws(
    () =>
      game.store.join("eleven", {
        code: game.room.code,
        nickname: "Full",
        avatar: 0,
      }),
    /full/,
  );
  assert.throws(() => game.act(game.ids[1], "start"), /host/);
  assert.throws(
    () => game.act(game.ids[1], "categories", { categories: ["food"] }),
    /host/,
  );
  assert.throws(() => game.act("stranger", "start"), /not in a room/);
  assert.equal(game.store.view("stranger"), null);
  assert.throws(
    () => game.store.create("new", { nickname: " ", avatar: 0 }),
    /nickname/,
  );
  assert.throws(
    () => game.store.create("new", { nickname: "New", avatar: "<svg>" }),
    /avatars/,
  );
  assert.throws(
    () => game.act(game.ids[0], "categories", { categories: ["made-up"] }),
    /valid categories/,
  );
  game.act(game.ids[0], "categories", { categories: [] });
  assert.throws(() => game.start(), /category/);
  game.act(game.ids[0], "categories", { categories: ["food", "food"] });
  assert.deepEqual(game.room.categories, ["food"]);
});

test("requires four connected players and reserves disconnected seats", () => {
  const game = setup(4);
  game.store.disconnect(game.ids[3]);
  assert.throws(() => game.start(), /4–10/);
  game.store.connect(game.ids[3]);
  game.start();
  assert.equal(game.room.phase, "reveal");
  const full = setup(10);
  full.store.disconnect(full.ids[9]);
  assert.throws(
    () =>
      full.store.join("late", {
        code: full.room.code,
        nickname: "Late",
        avatar: 1,
      }),
    /full/,
  );
});

test("private snapshots give exactly one imposter a category without the word or other roles", () => {
  const game = setup();
  game.start();
  const snapshots = game.ids.map((id) => game.store.view(id));
  const imposter = snapshots.find((view) => view.me.role === "imposter");
  assert.equal(
    snapshots.filter((view) => view.me.role === "imposter").length,
    1,
  );
  assert.equal(imposter.me.word, undefined);
  assert.ok(imposter.me.category);
  assert.ok(!JSON.stringify(imposter).includes(game.room.round.word.word));
  for (const view of snapshots) {
    assert.ok(
      view.players.every(
        (player) =>
          !("role" in player) && !("word" in player) && !("category" in player),
      ),
    );
    if (view.me.role === "insider")
      assert.equal(view.me.word, game.room.round.word.word);
  }
  // A client changing its projected objects cannot change authoritative state.
  snapshots[1].players[0].nickname = "tampered";
  snapshots[1].categories.length = 0;
  assert.equal(game.store.view(game.ids[1]).players[0].nickname, "Ada");
  assert.equal(game.room.categories.length, 6);
});

test("word, role, and shuffled speaking order use independent random draws", () => {
  const bounds = [];
  const draws = [3, 2, 1, 0, 1];
  const game = setup(4, {
    randomInt: (bound) => {
      bounds.push(bound);
      return draws.shift();
    },
  });
  game.start();
  assert.deepEqual(bounds, [WORDS.length, 4, 4, 3, 2]);
  assert.equal(game.room.round.imposterId, game.ids[2]);
  assert.deepEqual(game.room.round.order, [
    game.ids[2],
    game.ids[3],
    game.ids[0],
    game.ids[1],
  ]);
});

test("readiness, current turns, idempotence, stale tokens, pause and host advance are enforced", () => {
  const game = setup();
  game.start();
  const id = game.ids[0];
  const request = {
    actionId: "ready-retry",
    code: game.room.code,
    type: "ready",
    roundId: game.room.roundId,
  };
  game.store.act(id, request);
  game.store.act(id, request);
  assert.equal(game.room.round.ready.size, 1);
  assert.throws(() => game.act(id, "ready"), /already ready/);
  for (const other of game.ids.slice(1)) game.act(other, "ready");
  const speaker = game.room.round.order[0];
  const staleTurn = game.store.view(speaker).turn.id;
  assert.throws(
    () =>
      game.act(
        game.ids.find((value) => value !== speaker),
        "done",
      ),
    /your turn/,
  );
  assert.throws(
    () => game.act(speaker, "done", { roundId: -1 }),
    /earlier round/,
  );
  game.act(game.room.hostId, "pause");
  assert.throws(() => game.act(speaker, "done"), /paused/);
  game.act(game.room.hostId, "pause", { paused: false });
  const done = {
    actionId: "done-retry",
    code: game.room.code,
    type: "done",
    roundId: game.room.roundId,
    turnId: staleTurn,
  };
  game.store.act(speaker, done);
  game.store.act(speaker, done);
  assert.equal(game.room.round.turnIndex, 1);
  assert.throws(
    () => game.act(game.room.hostId, "advance", { turnId: staleTurn }),
    /already changed/,
  );
  assert.throws(() => game.act(game.ids[1], "advance"), /host/);
  game.store.disconnect(game.room.round.order[1]);
  game.act(game.room.hostId, "advance");
  assert.equal(game.room.round.turnIndex, 2);
});

test("discussion allows exactly one extra clue lap before voting", () => {
  const game = setup();
  assert.equal(game.store.view(game.ids[0]).lap, 0);
  game.start();
  game.ready();
  game.clues();
  assert.equal(game.room.phase, "discussion");
  assert.equal(game.store.view(game.ids[0]).lap, 1);
  assert.throws(() => game.act(game.ids[1], "extra-lap"), /host/);
  game.act(game.room.hostId, "extra-lap");
  assert.equal(game.store.view(game.ids[0]).turn.lap, 2);
  assert.deepEqual(game.store.view(game.ids[0]).turn.finishedIds, []);
  game.clues();
  assert.equal(game.store.view(game.ids[0]).lap, 2);
  assert.throws(
    () => game.act(game.room.hostId, "extra-lap"),
    /already been used/,
  );
  game.act(game.room.hostId, "vote-start");
  assert.equal(game.room.phase, "voting");
});

test("start and category actions reject stale rounds, including delayed requests after results", () => {
  const game = setup();
  const lobbyRound = game.room.roundId;
  assert.throws(
    () => game.act(game.ids[0], "start", { roundId: undefined }),
    /earlier round/,
  );
  assert.throws(
    () =>
      game.act(game.ids[0], "categories", {
        roundId: undefined,
        categories: ["food"],
      }),
    /earlier round/,
  );
  game.start();
  game.tick(120_000);
  assert.equal(game.room.phase, "results");
  assert.throws(
    () => game.act(game.ids[0], "start", { roundId: lobbyRound }),
    /earlier round/,
  );
  assert.throws(
    () =>
      game.act(game.ids[0], "categories", {
        roundId: lobbyRound,
        categories: ["food"],
      }),
    /earlier round/,
  );
  game.act(game.ids[0], "categories", { categories: ["food"] });
  game.start();
  assert.equal(game.room.roundId, 2);
});

test("every action is bound to its original room, including leave, even when round tokens match", () => {
  const game = setup();
  game.start();
  game.ready();
  const oldCode = game.room.code;
  const oldRoundId = game.room.roundId;
  const oldTurnId = game.store.view(game.ids[0]).turn.id;
  const leave = {
    code: oldCode,
    type: "leave",
    actionId: "original-room-leave",
  };
  game.store.act(game.ids[0], leave);
  const newRoom = game.store.create(game.ids[0], {
    nickname: "Ada",
    avatar: 0,
  });
  for (const [index, id] of game.ids.slice(1).entries()) {
    game.act(id, "leave");
    game.store.join(id, {
      code: newRoom.code,
      nickname: `Guest ${index + 1}`,
      avatar: index + 1,
    });
  }
  game.act(game.ids[0], "start");
  for (const id of game.ids) game.act(id, "ready");
  assert.equal(newRoom.roundId, oldRoundId);
  assert.equal(game.store.view(game.ids[0]).turn.id, oldTurnId);
  const revision = newRoom.revision;
  for (const type of [
    "categories",
    "start",
    "ready",
    "done",
    "pause",
    "advance",
    "extra-lap",
    "vote-start",
    "vote",
    "guess",
    "leave",
  ]) {
    assert.throws(
      () => game.act(game.ids[0], type, { code: oldCode }),
      /different room/,
    );
  }
  assert.throws(
    () => game.act(game.ids[0], "leave", { code: undefined }),
    /different room/,
  );
  assert.equal(newRoom.revision, revision);
  assert.equal(newRoom.round.turnIndex, 0);
  // A genuine retry of a previously applied leave is harmless after room switching.
  game.store.act(game.ids[0], leave);
  assert.equal(game.store.view(game.ids[0]).code, newRoom.code);
  assert.equal(newRoom.revision, revision);
});

test("action receipts stay bounded and recent duplicates remain idempotent for 24 hours", () => {
  const game = setup();
  for (let index = 0; index < 600; index++) {
    game.act(game.ids[0], "categories", {
      actionId: `bounded-${index}`,
      categories: ["food"],
    });
  }
  const receipts = game.store.receipts.get(game.ids[0]);
  assert.equal(receipts.size, 512);
  assert.equal(receipts.has("bounded-0"), false);
  assert.equal(receipts.has("bounded-599"), true);
  const revision = game.room.revision;
  game.tick(23 * 60 * 60_000);
  game.act(game.ids[0], "categories", {
    actionId: "bounded-599",
    categories: ["animals"],
  });
  assert.equal(game.room.revision, revision);
  assert.deepEqual(game.room.categories, ["food"]);
  game.tick(60 * 60_000);
  assert.equal(game.store.receipts.has(game.ids[0]), false);
});

test("private ballots reveal neither choices nor totals until every participant votes", () => {
  const game = setup();
  game.voting();
  const [a, b, c, d] = game.ids;
  assert.throws(() => game.act(a, "vote", { targetId: a }), /yourself/);
  assert.throws(
    () => game.act(a, "vote", { targetId: "stranger" }),
    /eligible/,
  );
  game.act(a, "vote", { targetId: b });
  const view = game.store.view(c);
  assert.equal(view.voting.submitted, 1);
  assert.equal(view.me.hasVoted, false);
  assert.deepEqual(view.ballots, []);
  assert.equal(JSON.stringify(view).includes("targetId"), false);
  assert.throws(() => game.act(a, "vote", { targetId: c }), /locked in/);
  game.act(b, "vote", { targetId: a });
  game.act(c, "vote", { targetId: b });
  game.act(d, "vote", { targetId: b });
  assert.equal(game.room.phase, "results");
  assert.equal(game.store.view(a).result.winner, "imposter");
  assert.equal(game.store.view(a).result.ballots[0].votes.length, 4);
  assert.equal(game.store.view(a).result.word, game.room.round.word.word);
});

test("caught imposter gets exactly one normalized final guess; insiders cannot guess", () => {
  const game = setup();
  game.voting();
  const [a, b] = game.ids;
  game.votes([b, a, a, a]);
  assert.equal(game.room.phase, "guess");
  assert.equal(game.store.view(a).me.word, undefined);
  assert.equal(
    JSON.stringify(game.store.view(a)).includes(game.room.round.word.word),
    false,
  );
  assert.equal(game.store.view(a).ballots.length, 1);
  assert.throws(
    () => game.act(b, "guess", { guess: "Popcorn" }),
    /accused imposter/,
  );
  game.act(a, "guess", { guess: "  POP - CORN!! " });
  assert.equal(game.store.view(a).result.winner, "imposter");
  assert.throws(() => game.act(a, "guess", { guess: "wrong" }), /phase/);
});

test("wrong final guess awards the group and records the attempted guess", () => {
  const game = setup();
  game.voting();
  const [a, b] = game.ids;
  game.votes([b, a, a, a]);
  assert.throws(
    () => game.act(a, "guess", { guess: "!!!" }),
    /letter or number/,
  );
  game.act(a, "guess", { guess: "Banana submarine" });
  assert.equal(game.store.view(b).result.winner, "group");
  assert.equal(game.store.view(b).result.guess, "Banana submarine");
});

test("one tied ballot opens a restricted runoff; a second tie awards the imposter", () => {
  const game = setup();
  game.voting();
  const [a, b, c] = game.ids;
  const closedBallotId = game.store.view(a).voting.id;
  game.votes([b, a, b, a]);
  assert.equal(game.room.phase, "runoff");
  const state = game.store.view(a);
  assert.deepEqual(state.voting.candidateIds, [a, b]);
  assert.equal(state.voting.submitted, 0);
  assert.equal(state.me.hasVoted, false);
  assert.equal(state.ballots[0].votes.length, 4);
  assert.throws(
    () => game.act(a, "vote", { targetId: b, votingId: closedBallotId }),
    /ballot has already closed/,
  );
  assert.equal(game.store.view(a).voting.submitted, 0);
  assert.throws(() => game.act(a, "vote", { targetId: c }), /eligible/);
  game.votes([b, a, b, a]);
  assert.equal(game.room.phase, "results");
  assert.equal(game.store.view(a).result.winner, "imposter");
  assert.equal(game.store.view(a).result.ballots.length, 2);
  assert.deepEqual(
    game.store.view(a).result.ballots.map((ballot) => ballot.runoff),
    [false, true],
  );
});

test("a decisive runoff can catch the imposter", () => {
  const game = setup();
  game.voting();
  const [a, b] = game.ids;
  game.votes([b, a, b, a]);
  game.votes([b, a, a, a]);
  assert.equal(game.room.phase, "guess");
  assert.equal(game.store.view(a).accusedId, a);
});

test("late arrivals have no secrets, cannot participate, and join the next round normally", () => {
  const game = setup();
  game.start();
  game.store.join("late", {
    code: game.room.code,
    nickname: "Late",
    avatar: 7,
  });
  const late = game.store.view("late");
  assert.equal(late.me.eligible, false);
  assert.equal(late.me.role, undefined);
  assert.equal(late.me.category, undefined);
  assert.equal(late.me.word, undefined);
  assert.equal(
    late.players.find((player) => player.id === "late").waiting,
    true,
  );
  assert.throws(() => game.act("late", "ready"), /waiting/);
  game.ready();
  game.clues();
  game.act(game.room.hostId, "vote-start");
  assert.equal(game.store.view("late").voting.total, 4);
  assert.throws(
    () => game.act("late", "vote", { targetId: game.ids[0] }),
    /waiting/,
  );
  const [a, b] = game.ids;
  game.votes([b, a, b, b]);
  game.start();
  assert.equal(game.room.round.participants.length, 5);
  assert.equal(game.store.view("late").me.eligible, true);
});

test("default two-minute grace restores the seat after a longer app switch without taking back host control", () => {
  const game = setup();
  assert.equal(GAME_TIMING.disconnectGraceMs, 120_000);
  assert.equal(game.store.graceMs, GAME_TIMING.disconnectGraceMs);
  game.start();
  game.ready();
  const before = game.store.view(game.ids[0]);
  game.store.disconnect(game.ids[0]);
  assert.equal(game.room.hostId, game.ids[1]);
  assert.equal(
    game.store.view(game.ids[1]).players[0].disconnectDeadline,
    1_000 + GAME_TIMING.disconnectGraceMs,
  );
  game.tick(90_000);
  assert.equal(game.room.phase, "clues");
  assert.ok(game.store.roomFor(game.ids[0]), "seat survives beyond one minute");
  game.store.connect(game.ids[0]);
  const after = game.store.view(game.ids[0]);
  assert.equal(after.me.role, before.me.role);
  assert.equal(after.me.category, before.me.category);
  assert.equal(after.hostId, game.ids[1]);
  assert.equal(after.players[0].connected, true);
  assert.equal(after.players[0].disconnectDeadline, null);
});

test("disconnect expiry abandons active rounds, preserves result roster, and removes membership", () => {
  const game = setup();
  game.start();
  game.ready();
  game.store.disconnect(game.ids[2]);
  game.tick(GAME_TIMING.disconnectGraceMs);
  assert.equal(game.room.phase, "results");
  assert.equal(game.store.view(game.ids[0]).result.winner, null);
  assert.match(game.store.view(game.ids[0]).result.reason, /seat expired/);
  assert.equal(game.store.view(game.ids[2]), null);
  assert.equal(
    game.store
      .view(game.ids[0])
      .players.find((player) => player.id === game.ids[2]).departed,
    true,
  );
  assert.equal(game.store.connect(game.ids[2]), null);
});

test("explicit participant leave abandons immediately and transfers host; leave retries are harmless", () => {
  const game = setup();
  game.start();
  const leave = { code: game.room.code, type: "leave", actionId: "leave-once" };
  game.store.act(game.ids[0], leave);
  game.store.act(game.ids[0], leave);
  assert.equal(game.room.hostId, game.ids[1]);
  assert.equal(game.room.phase, "results");
  assert.equal(game.store.view(game.ids[0]), null);
  assert.equal(game.store.view(game.ids[1]).result.winner, null);
});

test("waiting spectators may leave without abandoning a round", () => {
  const game = setup();
  game.start();
  game.store.join("late", {
    code: game.room.code,
    nickname: "Late",
    avatar: 1,
  });
  game.act("late", "leave");
  assert.equal(game.room.phase, "reveal");
  assert.equal(game.store.view("late"), null);
});

test("reveal and ballot deadlines abandon rather than inventing readiness or missing votes", () => {
  const reveal = setup();
  reveal.start();
  reveal.act(reveal.ids[0], "ready");
  reveal.tick(120_000);
  assert.equal(reveal.room.phase, "results");
  assert.equal(reveal.store.view(reveal.ids[0]).result.winner, null);
  const ballot = setup();
  ballot.voting();
  ballot.act(ballot.ids[0], "vote", { targetId: ballot.ids[1] });
  ballot.tick(90_000);
  assert.equal(ballot.room.phase, "results");
  assert.equal(ballot.store.view(ballot.ids[1]).result.winner, null);
  assert.deepEqual(ballot.store.view(ballot.ids[1]).result.ballots, []);
});

test("guess timeout forfeits to the group, but coincident disconnect expiry abandons first", () => {
  const game = setup();
  game.voting();
  game.votes([game.ids[1], game.ids[0], game.ids[0], game.ids[0]]);
  game.tick(60_000);
  assert.equal(game.store.view(game.ids[0]).result.winner, "group");
  const disconnected = setup(4, { graceMs: 60_000 });
  disconnected.voting();
  disconnected.votes([
    disconnected.ids[1],
    disconnected.ids[0],
    disconnected.ids[0],
    disconnected.ids[0],
  ]);
  disconnected.store.disconnect(disconnected.ids[0]);
  disconnected.tick(60_000);
  assert.equal(
    disconnected.store.view(disconnected.ids[1]).result.winner,
    null,
  );
});

test("disconnect grace does not extend ballot or final-guess deadlines", () => {
  const ballot = setup();
  ballot.voting();
  ballot.store.disconnect(ballot.ids[2]);
  ballot.tick(90_000);
  assert.equal(ballot.room.phase, "results");
  assert.equal(ballot.room.round.result.winner, null);
  assert.match(ballot.room.round.result.reason, /ballot deadline/);
  assert.equal(ballot.room.players.get(ballot.ids[2]).departed, false);
  assert.ok(ballot.store.roomFor(ballot.ids[2]));

  const guess = setup();
  guess.voting();
  guess.votes([guess.ids[1], guess.ids[0], guess.ids[0], guess.ids[0]]);
  guess.store.disconnect(guess.ids[0]);
  guess.tick(60_000);
  assert.equal(guess.room.phase, "results");
  assert.equal(guess.room.round.result.winner, "group");
  assert.match(guess.room.round.result.reason, /ran out of time/);
  assert.equal(guess.room.players.get(guess.ids[0]).departed, false);
  assert.ok(guess.store.roomFor(guess.ids[0]));
});

test("empty rooms expire 30 minutes after their last reserved seat leaves", () => {
  const game = setup(1);
  game.store.disconnect(game.ids[0]);
  game.tick(GAME_TIMING.disconnectGraceMs);
  assert.equal(game.room.hostId, null);
  game.tick(30 * 60_000 - 1);
  assert.ok(game.store.rooms.has(game.room.code));
  game.tick(1);
  assert.equal(game.store.rooms.has(game.room.code), false);
});

test("new rounds refresh roles and avoid repeated words until the selected pool is exhausted", () => {
  const game = setup();
  game.act(game.ids[0], "categories", { categories: ["food"] });
  const words = [];
  for (let index = 0; index < 21; index++) {
    game.start();
    words.push(game.store.view(game.ids[1]).me.word);
    game.tick(120_000);
  }
  assert.equal(new Set(words.slice(0, 20)).size, 20);
  assert.equal(words[20], words[0]);
  assert.equal(game.room.roundNumber, 21);
  game.start();
  assert.throws(
    () => game.act(game.ids[1], "ready", { roundId: game.room.roundId - 1 }),
    /earlier round/,
  );
});
