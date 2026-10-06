import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { io } from "socket.io-client";
import { createAlibiServer } from "../server/index.js";
import { GameStore } from "../server/game.js";
import { CATEGORIES } from "../server/words.js";
import { CONNECTION_ERRORS, GAME_TIMING } from "../shared/protocol.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, description, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function fixture(t, count = 4) {
  let now = Date.now();
  const store = new GameStore({ now: () => now });
  const server = await createAlibiServer({ store });
  const port = await server.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;
  const clients = [];
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  });

  async function socketFor(cookie, extra = {}) {
    const socket = io(origin, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      autoConnect: false,
      extraHeaders: { Cookie: cookie, Origin: origin },
      ...extra,
    });
    sockets.push(socket);
    return socket;
  }

  async function connectClient(client) {
    const socket = await socketFor(client.cookie);
    client.socket = socket;
    socket.on("state", (state) => {
      client.state = state;
      client.states.push(structuredClone(state));
    });
    socket.onAny((event, payload) =>
      client.events.push({ event, payload: structuredClone(payload) }),
    );
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
      socket.connect();
    });
    return socket;
  }

  async function newClient(nickname = `Player ${clients.length + 1}`) {
    const response = await fetch(`${origin}/api/session`, {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const { playerId } = await response.json();
    assert.equal(typeof playerId, "string");
    const client = {
      id: playerId,
      nickname,
      cookie: setCookie.split(";")[0],
      state: null,
      states: [],
      events: [],
    };
    clients.push(client);
    await connectClient(client);
    return client;
  }

  async function raw(client, event, payload) {
    return client.socket.timeout(2500).emitWithAck(event, payload);
  }

  function envelope(client, type, payload = {}) {
    return {
      type,
      actionId: randomUUID(),
      code: client.state?.code,
      ...(client.state?.roundId !== undefined
        ? { roundId: client.state.roundId }
        : {}),
      ...(["done", "pause", "advance"].includes(type)
        ? { turnId: client.state?.turn?.id }
        : {}),
      ...(type === "vote" ? { votingId: client.state?.voting?.id } : {}),
      ...payload,
    };
  }

  async function act(client, type, payload = {}) {
    const ack = await raw(client, "action", envelope(client, type, payload));
    assert.equal(
      ack.ok,
      true,
      `${type}: ${ack.error ?? "missing acknowledgement"}`,
    );
    await delay(10);
    return ack;
  }

  for (let i = 0; i < count; i++) await newClient();
  const host = clients[0];
  assert.equal(
    (await raw(host, "room:create", { nickname: host.nickname, avatar: 0 })).ok,
    true,
  );
  await until(() => host.state?.code, "room creation");
  const code = host.state.code;
  for (const client of clients.slice(1)) {
    assert.equal(
      (
        await raw(client, "room:join", {
          code,
          nickname: client.nickname,
          avatar: 1,
        })
      ).ok,
      true,
    );
  }
  await until(
    () => clients.every((client) => client.state?.players.length === count),
    "all players joining",
  );

  async function start() {
    await act(host, "categories", { categories: [CATEGORIES[0].id] });
    await act(host, "start");
    await until(
      () =>
        clients
          .slice(0, count)
          .every((client) => client.state?.phase === "reveal"),
      "private role reveal",
    );
    const participants = clients.slice(0, count);
    const imposter = participants.find(
      (client) => client.state.me.role === "imposter",
    );
    assert.ok(imposter, "one client receives the imposter role");
    assert.equal(
      participants.filter((client) => client.state.me.role === "imposter")
        .length,
      1,
    );
    const insiders = participants.filter((client) => client !== imposter);
    const word = insiders[0].state.me.word;
    assert.equal(typeof word, "string");
    assert.ok(word.length);
    assert.ok(insiders.every((client) => client.state.me.word === word));
    assert.equal(imposter.state.me.word, undefined);
    return { participants, imposter, insiders, word };
  }

  async function toDiscussion(round) {
    for (const client of round.participants) await act(client, "ready");
    await until(() => host.state.phase === "clues", "clue phase");
    while (host.state.phase === "clues") {
      const speaker = clients.find(
        (client) => client.id === host.state.turn.currentId,
      );
      assert.ok(speaker, "the current speaker is an actual session");
      await act(speaker, "done");
    }
    assert.equal(host.state.phase, "discussion");
  }

  async function ballot(round, accused) {
    for (const client of round.participants) {
      const target =
        client === accused
          ? round.participants.find((other) => other !== accused)
          : accused;
      await act(client, "vote", { targetId: target.id });
    }
  }

  return {
    server,
    store,
    origin,
    clients,
    host,
    code,
    newClient,
    connectClient,
    socketFor,
    raw,
    envelope,
    act,
    start,
    toDiscussion,
    ballot,
    advanceTime(ms) {
      now += ms;
      store.sweep();
    },
  };
}

function assertPrivate(round) {
  for (const { event, payload } of round.imposter.events) {
    if (
      event === "state" &&
      (!payload ||
        payload.roundId !== round.imposter.state.roundId ||
        payload.phase === "results")
    )
      continue;
    assert.ok(
      !JSON.stringify(payload).includes(JSON.stringify(round.word)),
      `${event} payload must not contain the secret before results`,
    );
  }
  for (const state of round.imposter.states.filter(
    (state) =>
      state?.roundId === round.imposter.state.roundId &&
      state.phase !== "results",
  )) {
    assert.equal(state.me.word, undefined);
    assert.ok(
      !JSON.stringify(state).includes(JSON.stringify(round.word)),
      "imposter snapshots must never contain the secret before results",
    );
    assert.ok(!state.result);
    for (const player of state.players) {
      assert.equal(player.role, undefined);
      assert.equal(player.word, undefined);
    }
    if (state.voting) {
      assert.equal(state.voting.votes, undefined);
      assert.equal(state.voting.totals, undefined);
    }
  }
}

test("four independent sessions complete innocent accusation and reuse the room with a new word", async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  await f.toDiscussion(first);
  await f.act(f.host, "vote-start");
  const firstVoter = first.participants[0];
  const selfVote = await f.raw(
    firstVoter,
    "action",
    f.envelope(firstVoter, "vote", { targetId: firstVoter.id }),
  );
  assert.equal(selfVote.ok, false);
  await f.ballot(first, first.insiders[0]);
  await until(
    () => f.clients.every((client) => client.state.phase === "results"),
    "result fanout",
  );
  assert.equal(f.host.state.result.winner, "imposter");
  assert.equal(f.host.state.result.word, first.word);
  assert.equal(f.host.state.result.imposterId, first.imposter.id);
  assert.equal(f.host.state.result.ballots[0].votes.length, 4);
  assertPrivate(first);
  const oldRoundId = f.host.state.roundId;
  const second = await f.start();
  assert.notEqual(f.host.state.roundId, oldRoundId);
  assert.notEqual(second.word, first.word);
  assert.ok(f.clients.every((client) => client.state.me.eligible));
});

for (const correct of [true, false]) {
  test(`caught imposter ${correct ? "wins with a normalized correct guess" : "loses with an incorrect guess"}`, async (t) => {
    const f = await fixture(t);
    const round = await f.start();
    await f.toDiscussion(round);
    await f.act(f.host, "vote-start");
    await f.ballot(round, round.imposter);
    await until(() => f.host.state.phase === "guess", "final guess phase");
    assertPrivate(round);
    const forbidden = await f.raw(
      round.insiders[0],
      "action",
      f.envelope(round.insiders[0], "guess", {
        guess: round.word,
        playerId: round.imposter.id,
      }),
    );
    assert.equal(forbidden.ok, false);
    await f.act(round.imposter, "guess", {
      guess: correct
        ? `  ${round.word.toUpperCase()}!!!  `
        : "a definitely incorrect answer 8675309",
    });
    await until(
      () => f.clients.every((client) => client.state.phase === "results"),
      "guess results",
    );
    assert.equal(f.host.state.result.winner, correct ? "imposter" : "group");
    assert.equal(f.host.state.result.word, round.word);
    assertPrivate(round);
  });
}

test("private ties run off once, a second tie lets the imposter escape", async (t) => {
  const f = await fixture(t);
  const round = await f.start();
  await f.toDiscussion(round);
  await f.act(f.host, "vote-start");
  const [a, b, c, d] = round.participants;
  const initialBallotId = a.state.voting.id;
  for (const [voter, target] of [
    [a, b],
    [b, a],
    [c, a],
  ]) {
    await f.act(voter, "vote", { targetId: target.id });
    assert.equal(f.host.state.phase, "voting");
    assert.ok(!f.host.state.result);
    assert.equal(f.host.state.voting.votes, undefined);
  }
  await f.act(d, "vote", { targetId: b.id });
  await until(() => f.host.state.voting?.runoff, "runoff");
  assert.deepEqual(
    new Set(f.host.state.voting.candidateIds),
    new Set([a.id, b.id]),
  );
  const staleBallot = await f.raw(
    a,
    "action",
    f.envelope(a, "vote", { targetId: b.id, votingId: initialBallotId }),
  );
  assert.equal(
    staleBallot.ok,
    false,
    "an earlier ballot cannot submit a vote in the runoff",
  );
  for (const [voter, target] of [
    [a, b],
    [b, a],
    [c, a],
    [d, b],
  ])
    await f.act(voter, "vote", { targetId: target.id });
  await until(() => f.host.state.phase === "results", "tied result");
  assert.equal(f.host.state.result.winner, "imposter");
  assert.equal(f.host.state.result.ballots.length, 2);
  assertPrivate(round);
});

test("late joiners receive no secrets, authorization is session bound, stale and duplicate turns do not advance twice", async (t) => {
  const f = await fixture(t);
  const forbiddenHost = await f.raw(
    f.clients[1],
    "action",
    f.envelope(f.clients[1], "start", {
      playerId: f.host.id,
      hostId: f.clients[1].id,
    }),
  );
  assert.equal(forbiddenHost.ok, false);
  const round = await f.start();
  const late = await f.newClient("Late arrival");
  assert.equal(
    (
      await f.raw(late, "room:join", {
        code: f.code,
        nickname: late.nickname,
        avatar: 2,
      })
    ).ok,
    true,
  );
  await until(() => late.state?.code, "late join projection");
  assert.equal(late.state.me.eligible, false);
  for (const field of ["word", "role", "category"])
    assert.equal(late.state.me[field], undefined);
  assert.equal(
    late.state.players.find((player) => player.id === late.id).waiting,
    true,
  );
  assert.equal(
    (await f.raw(late, "action", f.envelope(late, "ready"))).ok,
    false,
  );
  for (const client of round.participants) await f.act(client, "ready");
  await until(() => f.host.state.phase === "clues", "clue phase");
  const speaker = f.clients.find(
    (client) => client.id === f.host.state.turn.currentId,
  );
  const notSpeaker = round.participants.find((client) => client !== speaker);
  const wrongPlayer = await f.raw(
    notSpeaker,
    "action",
    f.envelope(notSpeaker, "done", { playerId: speaker.id }),
  );
  assert.equal(wrongPlayer.ok, false);
  const done = f.envelope(speaker, "done");
  assert.equal((await f.raw(speaker, "action", done)).ok, true);
  await until(
    () => f.host.state.turn.currentId !== speaker.id,
    "one turn advancement",
  );
  const nextTurn = f.host.state.turn.id;
  assert.equal(
    (await f.raw(speaker, "action", done)).ok,
    true,
    "exact duplicates are idempotent",
  );
  assert.equal(f.host.state.turn.id, nextTurn);
  const stale = await f.raw(speaker, "action", {
    ...done,
    actionId: randomUUID(),
  });
  assert.equal(stale.ok, false);
  assert.equal(f.host.state.turn.id, nextTurn);
  for (const state of late.states.filter(Boolean)) {
    assert.ok(
      !JSON.stringify(state).includes(JSON.stringify(round.word)),
      "late clients never receive the current word",
    );
  }
});

test("refresh uses the same session, multiple tabs preserve presence, host disconnect transfers control", async (t) => {
  const f = await fixture(t);
  const round = await f.start();
  const player = f.clients[1];
  const role = structuredClone(player.state.me);
  const refreshed = await fetch(`${f.origin}/api/session`, {
    method: "POST",
    headers: { Origin: f.origin, Cookie: player.cookie },
  });
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).playerId, player.id);
  const oldSocket = player.socket;
  await f.connectClient(player);
  oldSocket.disconnect();
  await delay(50);
  assert.equal(
    f.host.state.players.find((item) => item.id === player.id).connected,
    true,
  );
  assert.equal(player.state.me.role, role.role);
  assert.equal(player.state.me.word, role.word);
  player.socket.disconnect();
  await until(
    () => !f.host.state.players.find((item) => item.id === player.id).connected,
    "last-tab disconnect",
  );
  f.advanceTime(90_000);
  await f.connectClient(player);
  await until(
    () => f.host.state.players.find((item) => item.id === player.id).connected,
    "seat restored",
  );
  assert.equal(player.state.me.role, role.role);
  assert.equal(player.state.me.word, role.word);
  const oldHost = f.host.id;
  f.host.socket.disconnect();
  await until(() => player.state.hostId !== oldHost, "host transfer");
  const newHost = player.state.hostId;
  await f.connectClient(f.host);
  await until(
    () => f.host.state.hostId === newHost,
    "reconnected host observes new ownership",
  );
  assert.equal(f.host.state.me.isHost, false);
  assertPrivate(round);
});

test("foreground state sync emits a fresh private snapshot without mutating the game", async (t) => {
  const f = await fixture(t);
  const round = await f.start();
  await f.toDiscussion(round);
  await f.act(f.host, "vote-start");
  await f.act(round.insiders[0], "vote", { targetId: round.imposter.id });
  for (const player of [round.imposter, round.insiders[0]]) {
    const before = structuredClone(player.state);
    const count = player.states.length;
    const ack = await f.raw(player, "state:sync", {});
    assert.equal(ack.ok, true);
    await until(() => player.states.length > count, "fresh unchanged snapshot");
    assert.deepEqual(player.state, before);
    assert.equal(player.state.voting.submitted, 1);
    assert.deepEqual(player.state.ballots, []);
    assert.equal(JSON.stringify(player.state).includes("targetId"), false);
  }
  const count = round.imposter.states.length;
  const identityAttempt = await f.raw(round.imposter, "state:sync", {
    playerId: round.insiders[0].id,
  });
  if (identityAttempt.ok) {
    await until(
      () => round.imposter.states.length > count,
      "session-bound sync snapshot",
    );
    assert.equal(round.imposter.state.me.id, round.imposter.id);
  }
  assertPrivate(round);
});

test("host explicit departure abandons an active round and transfers the room", async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.act(f.host, "leave");
  await until(
    () => f.clients[1].state.phase === "results",
    "round abandonment",
  );
  assert.notEqual(f.clients[1].state.hostId, f.host.id);
  assert.equal(f.clients[1].state.result.winner, null);
  assert.ok(f.clients[1].state.result.reason);
});

test("actions delayed in an old tab cannot leave or change a newly joined room", async (t) => {
  const f = await fixture(t);
  const oldCode = f.host.state.code;
  const staleLeave = f.envelope(f.host, "leave");
  const staleCategories = f.envelope(f.host, "categories", { categories: [] });
  await f.act(f.host, "leave");
  assert.equal(
    (
      await f.raw(f.host, "room:create", {
        nickname: f.host.nickname,
        avatar: 0,
      })
    ).ok,
    true,
  );
  await until(
    () => f.host.state?.code && f.host.state.code !== oldCode,
    "new room creation",
  );
  const newCode = f.host.state.code;
  const categories = [...f.host.state.categories];
  for (const payload of [staleLeave, staleCategories]) {
    const ack = await f.raw(f.host, "action", payload);
    assert.equal(
      ack.ok,
      false,
      "an action from the previous room must be rejected",
    );
    assert.equal(f.store.view(f.host.id).code, newCode);
    assert.deepEqual(f.store.view(f.host.id).categories, categories);
  }
});

test("a disconnected participant whose grace expires abandons the round without inventing votes", async (t) => {
  const f = await fixture(t);
  const round = await f.start();
  await f.toDiscussion(round);
  f.clients[1].socket.disconnect();
  await until(
    () =>
      !f.host.state.players.find((player) => player.id === f.clients[1].id)
        .connected,
    "disconnect recorded",
  );
  f.advanceTime(GAME_TIMING.disconnectGraceMs + 1);
  await until(
    () => f.host.state.phase === "results",
    "expired-grace broadcast",
  );
  assert.equal(f.host.state.result.winner, null);
  assert.match(f.host.state.result.reason, /seat expired/);
  assert.equal(f.host.state.voting, null);
  assert.ok(
    !f.host.state.result.ballots.some((ballot) => ballot.votes.length),
    "missing voters are not converted into ballots",
  );
});

for (const phase of ["reveal", "voting", "guess"]) {
  test(`${phase} deadline produces an explicit result`, async (t) => {
    const f = await fixture(t);
    const round = await f.start();
    if (phase !== "reveal") {
      await f.toDiscussion(round);
      await f.act(f.host, "vote-start");
      if (phase === "guess") await f.ballot(round, round.imposter);
    }
    assert.equal(f.host.state.phase, phase);
    f.advanceTime(
      phase === "reveal" ? 120_001 : phase === "voting" ? 90_001 : 60_001,
    );
    await until(
      () => f.host.state.phase === "results",
      `${phase} timeout broadcast`,
    );
    assert.equal(
      f.host.state.result.winner,
      phase === "guess" ? "group" : null,
    );
    assert.ok(f.host.state.result.reason);
  });
}

test("HTTP and socket boundaries reject cross-origin requests and unauthenticated identity claims", async (t) => {
  const f = await fixture(t);
  for (const headers of [{ Origin: "https://malicious.example" }, {}]) {
    const response = await fetch(`${f.origin}/api/session`, {
      method: "POST",
      headers,
    });
    assert.equal(response.status, 403);
  }
  const wordResponse = await fetch(`${f.origin}/server/words.js`);
  assert.notEqual(
    wordResponse.status,
    200,
    "server word collection is never a static asset",
  );
  const attempts = [
    {
      extraHeaders: { Origin: f.origin },
      auth: { playerId: f.host.id },
      query: { playerId: f.host.id },
    },
    {
      extraHeaders: {
        Origin: "https://malicious.example",
        Cookie: f.host.cookie,
      },
    },
    { extraHeaders: { Cookie: f.host.cookie } },
  ];
  for (const options of attempts) {
    const socket = await f.socketFor("", options);
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 2500);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve("connected");
      });
      socket.once("connect_error", () => {
        clearTimeout(timer);
        resolve("rejected");
      });
      socket.connect();
    });
    assert.equal(result, "rejected");
    socket.disconnect();
  }
});

test("a healthy restarted server rejects old sessions explicitly and a fresh bootstrap reconnects", async (t) => {
  let server = await createAlibiServer();
  const port = await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await server.close();
  });
  const bootstrap = (cookie = "") =>
    fetch(`${origin}/api/session`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    });
  const first = await bootstrap();
  const oldCookie = first.headers.get("set-cookie").split(";")[0];
  const oldIdentity = await first.json();
  await server.close();
  server = await createAlibiServer();
  await server.listen(port);
  assert.deepEqual(await (await fetch(`${origin}/api/health`)).json(), {
    ok: true,
  });

  const connect = (cookie) => {
    const socket = io(origin, {
      transports: ["websocket"],
      forceNew: true,
      autoConnect: false,
      extraHeaders: { Origin: origin, Cookie: cookie },
    });
    sockets.push(socket);
    return socket;
  };
  const stale = connect(oldCookie);
  const rejection = await new Promise((resolve) => {
    stale.once("connect_error", resolve);
    stale.connect();
  });
  assert.equal(rejection.data.code, CONNECTION_ERRORS.sessionExpired);
  assert.equal(
    stale.active,
    false,
    "authentication rejection does not retry automatically",
  );

  const fresh = await bootstrap(oldCookie);
  assert.equal(fresh.status, 200);
  assert.notEqual((await fresh.json()).playerId, oldIdentity.playerId);
  const socket = connect(fresh.headers.get("set-cookie").split(";")[0]);
  const snapshot = await new Promise((resolve, reject) => {
    socket.once("state", resolve);
    socket.once("connect_error", reject);
    socket.connect();
  });
  assert.equal(socket.connected, true);
  assert.equal(
    snapshot,
    null,
    "a restart does not recover a lost room or private role",
  );
});

async function sessionServer(t, options = {}) {
  const server = await createAlibiServer(options);
  const port = await server.listen(0, "127.0.0.1");
  const origin = `http://127.0.0.1:${port}`;
  t.after(() => server.close());
  const post = async (headers = {}) => {
    const res = await fetch(`${origin}/api/session`, {
      method: "POST",
      headers: { Origin: origin, ...headers },
    });
    return {
      status: res.status,
      cookie: res.headers.get("set-cookie")?.split(";")[0],
    };
  };
  const burst = async (count, headers) => {
    const statuses = [];
    for (let i = 0; i < count; i++) statuses.push((await post(headers)).status);
    return statuses;
  };
  return { post, burst };
}

test("without trusted proxies, X-Forwarded-For cannot dodge the new-session limit", async (t) => {
  const { post, burst } = await sessionServer(t);
  const statuses = [];
  for (let i = 0; i < 60; i++)
    statuses.push(
      (await post({ "X-Forwarded-For": `198.51.100.${i}` })).status,
    );
  assert.deepEqual(new Set(statuses), new Set([200]));
  assert.equal(
    (await post({ "X-Forwarded-For": "198.51.100.200" })).status,
    429,
  );
  assert.deepEqual(new Set(await burst(2)), new Set([429]));
});

test("behind one trusted proxy, separate clients get separate buckets and spoofed entries are ignored", async (t) => {
  const { post, burst } = await sessionServer(t, { trustProxyHops: 1 });
  const first = { "X-Forwarded-For": "203.0.113.1" };
  assert.deepEqual(new Set(await burst(60, first)), new Set([200]));
  assert.equal((await post(first)).status, 429);
  // A client prepending fake addresses still lands in its real bucket.
  assert.equal(
    (await post({ "X-Forwarded-For": "10.9.9.9, 203.0.113.1" })).status,
    429,
  );
  // A different client behind the same proxy is unaffected.
  assert.equal((await post({ "X-Forwarded-For": "203.0.113.2" })).status, 200);
});

test("returning players are limited per session, not by a shared network address", async (t) => {
  const { post, burst } = await sessionServer(t);
  const returning = await post();
  assert.equal(returning.status, 200);
  // Others on the same address exhaust the new-session bucket.
  await burst(59);
  assert.equal((await post()).status, 429);
  // The returning player's refresh still works on its own session bucket.
  assert.equal((await post({ Cookie: returning.cookie })).status, 200);
  const own = await burst(29, { Cookie: returning.cookie });
  assert.deepEqual(new Set(own), new Set([200]));
  assert.equal((await post({ Cookie: returning.cookie })).status, 429);
});

test("TRUST_PROXY_HOPS must be a small whole number", async () => {
  for (const trustProxyHops of [-1, 1.5, 9, Number.NaN])
    await assert.rejects(
      createAlibiServer({ trustProxyHops }),
      /TRUST_PROXY_HOPS/,
    );
});

test("custom avatars reach every player over the socket", async (t) => {
  const game = await fixture(t, 1);
  const look = { color: 8, face: 6, hat: 3, glasses: 1, mustache: 2 };
  const host = await game.newClient("Host");
  const guest = await game.newClient("Guest");
  assert.equal(
    (await game.raw(host, "room:create", { nickname: "Host", avatar: look }))
      .ok,
    true,
  );
  const code = host.state.code;
  const rejected = await game.raw(guest, "room:join", {
    nickname: "Guest",
    code,
    avatar: { ...look, hat: 99 },
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /avatars/);
  assert.equal(
    (
      await game.raw(guest, "room:join", {
        nickname: "Guest",
        code,
        avatar: { ...look, color: 2 },
      })
    ).ok,
    true,
  );
  await until(() => host.state?.players.length === 2, "host to see the guest");
  const byName = (state, n) => state.players.find((p) => p.nickname === n);
  assert.deepEqual(byName(guest.state, "Host").avatar, look);
  assert.deepEqual(byName(host.state, "Guest").avatar, { ...look, color: 2 });
});
