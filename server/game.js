import { randomInt as secureRandomInt } from "node:crypto";
import { CATEGORIES, WORDS } from "./words.js";

const ACTIVE_PHASES = new Set([
  "reveal",
  "clues",
  "discussion",
  "voting",
  "runoff",
  "guess",
]);
const ROUND_ACTIONS = new Set([
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
]);
const TURN_ACTIONS = new Set(["done", "pause", "advance"]);
const CATEGORY_IDS = new Set(CATEGORIES.map((category) => category.id));
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const EMPTY_ROOM_TTL = 30 * 60_000;
const RECEIPT_TTL = 24 * 60 * 60_000;
// Keep ordinary retries idempotent for 24 hours, with a hard memory bound for
// busy or abusive sessions. Round/turn/ballot tokens remain independently checked.
const MAX_RECEIPTS_PER_PLAYER = 512;

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function profile({ nickname, avatar } = {}) {
  requireThat(typeof nickname === "string", "Please enter a nickname.");
  nickname = nickname
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  requireThat(
    nickname.length >= 1 && nickname.length <= 20,
    "Use a nickname between 1 and 20 characters.",
  );
  requireThat(
    Number.isInteger(avatar) && avatar >= 0 && avatar <= 7,
    "Choose one of the eight avatars.",
  );
  return { nickname, avatar };
}

export function normalizeGuess(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function copyBallots(ballots) {
  return ballots.map((ballot) => ({
    runoff: ballot.runoff,
    votes: ballot.votes.map((vote) => ({ ...vote })),
  }));
}

/** Server-owned state. Only view() is safe to serialize to a player. */
export class GameStore {
  constructor({
    now = Date.now,
    randomInt = secureRandomInt,
    graceMs = 60_000,
  } = {}) {
    this.now = now;
    this.randomInt = randomInt;
    this.graceMs = graceMs;
    this.rooms = new Map();
    this.memberships = new Map();
    this.receipts = new Map();
  }

  roomFor(playerId) {
    return this.rooms.get(this.memberships.get(playerId)) ?? null;
  }

  create(playerId, input) {
    this.sweep();
    requireThat(
      !this.roomFor(playerId),
      "Leave your current room before creating another.",
    );
    const identity = profile(input);
    let code;
    do {
      // Invite generation is independent of deterministic gameplay randomness.
      code = Array.from(
        { length: 6 },
        () => ROOM_ALPHABET[secureRandomInt(ROOM_ALPHABET.length)],
      ).join("");
    } while (this.rooms.has(code));
    const room = {
      code,
      hostId: playerId,
      phase: "lobby",
      roundNumber: 0,
      roundId: 0,
      revision: 1,
      categories: CATEGORIES.map((category) => category.id),
      players: new Map(),
      usedWords: new Set(),
      round: null,
      emptySince: null,
      notice: null,
    };
    room.players.set(playerId, this.newPlayer(playerId, identity));
    this.rooms.set(code, room);
    this.memberships.set(playerId, code);
    return room;
  }

  join(playerId, input = {}) {
    this.sweep();
    requireThat(typeof input.code === "string", "Enter a room code.");
    const code = input.code.trim().toUpperCase();
    const existing = this.roomFor(playerId);
    requireThat(
      !existing || existing.code === code,
      "Leave your current room before joining another.",
    );
    const room = this.rooms.get(code);
    requireThat(
      room,
      "That room could not be found. Check the code or ask for a fresh invite.",
    );
    if (existing) return room;
    const identity = profile(input);
    requireThat(
      [...room.players.values()].filter((player) => !player.departed).length <
        10,
      "This room is full (10 players).",
    );
    // A departed participant can return as a waiting seat, but never reclaim secrets.
    room.players.set(playerId, this.newPlayer(playerId, identity));
    if (room.round?.participants.includes(playerId))
      room.round.ineligible.add(playerId);
    this.memberships.set(playerId, code);
    room.emptySince = null;
    if (!room.hostId) room.hostId = playerId;
    room.revision++;
    return room;
  }

  newPlayer(id, identity) {
    return {
      id,
      ...identity,
      connected: true,
      departed: false,
      disconnectDeadline: null,
    };
  }

  connect(playerId) {
    this.sweep();
    const room = this.roomFor(playerId);
    if (!room) return null;
    const player = room.players.get(playerId);
    if (!player.connected) {
      player.connected = true;
      player.disconnectDeadline = null;
      if (!room.hostId) room.hostId = playerId;
      room.emptySince = null;
      room.revision++;
    }
    return room;
  }

  disconnect(playerId) {
    const room = this.roomFor(playerId);
    if (!room) return null;
    const player = room.players.get(playerId);
    if (player.connected) {
      player.connected = false;
      player.disconnectDeadline = this.now() + this.graceMs;
      this.transferHost(room);
      room.revision++;
    }
    return room;
  }

  transferHost(room) {
    if (
      room.players.get(room.hostId)?.connected &&
      !room.players.get(room.hostId)?.departed
    )
      return;
    room.hostId =
      [...room.players.values()].find(
        (player) => player.connected && !player.departed,
      )?.id ?? null;
  }

  act(playerId, action = {}) {
    requireThat(
      action && typeof action === "object" && !Array.isArray(action),
      "That action is not valid.",
    );
    requireThat(
      typeof action.actionId === "string" &&
        action.actionId.length >= 1 &&
        action.actionId.length <= 100,
      "This action needs a unique action ID. Please refresh and try again.",
    );
    const receipt = this.receipts.get(playerId)?.get(action.actionId);
    if (receipt !== undefined && this.now() - receipt < RECEIPT_TTL)
      return this.roomFor(playerId);
    this.sweep();
    const room = this.roomFor(playerId);
    requireThat(room, "You are not in a room. Join a room first.");
    requireThat(
      action.code === room.code,
      "That action belongs to a different room.",
    );
    requireThat(
      room.players.get(playerId)?.connected,
      "Reconnect before taking an action.",
    );
    if (ROUND_ACTIONS.has(action.type)) {
      requireThat(
        action.roundId === room.roundId,
        "That action belongs to an earlier round.",
      );
    }
    if (TURN_ACTIONS.has(action.type)) {
      requireThat(
        room.phase === "clues" && action.turnId === this.turnId(room),
        "That turn has already changed.",
      );
    }
    const isHost = () =>
      requireThat(room.hostId === playerId, "Only the host can do that.");
    const inPhase = (...phases) =>
      requireThat(
        phases.includes(room.phase),
        "That action is not available in this phase.",
      );
    const participant = () =>
      requireThat(
        this.eligible(room, playerId),
        "You are waiting for the next round.",
      );
    const round = room.round;

    switch (action.type) {
      case "categories": {
        isHost();
        inPhase("lobby", "results");
        requireThat(
          Array.isArray(action.categories) &&
            action.categories.length <= CATEGORIES.length &&
            action.categories.every(
              (id) => typeof id === "string" && CATEGORY_IDS.has(id),
            ),
          "Choose valid categories.",
        );
        room.categories = [...new Set(action.categories)];
        break;
      }
      case "start":
        isHost();
        inPhase("lobby", "results");
        this.start(room);
        break;
      case "ready":
        inPhase("reveal");
        participant();
        requireThat(!round.ready.has(playerId), "You are already ready.");
        round.ready.add(playerId);
        if (round.ready.size === round.participants.length) {
          room.phase = "clues";
          round.phaseDeadline = null;
        }
        break;
      case "done":
        inPhase("clues");
        participant();
        requireThat(!round.paused, "The host has paused the turn.");
        requireThat(
          round.order[round.turnIndex] === playerId,
          "Wait for your turn to give a clue.",
        );
        this.advance(room);
        break;
      case "pause":
        isHost();
        inPhase("clues");
        requireThat(
          action.paused === undefined || typeof action.paused === "boolean",
          "Invalid pause setting.",
        );
        round.paused = action.paused ?? !round.paused;
        break;
      case "advance":
        isHost();
        inPhase("clues");
        this.advance(room);
        break;
      case "extra-lap":
        isHost();
        inPhase("discussion");
        requireThat(
          round.lap === 1,
          "The extra clue lap has already been used.",
        );
        round.lap = 2;
        round.turnIndex = 0;
        round.turnVersion++;
        round.paused = false;
        room.phase = "clues";
        break;
      case "vote-start":
        isHost();
        inPhase("discussion");
        this.openVote(room, round.participants, false);
        break;
      case "vote":
        inPhase("voting", "runoff");
        participant();
        requireThat(
          action.votingId === this.votingId(room),
          "That ballot has already closed.",
        );
        requireThat(
          !round.votes.has(playerId),
          "Your vote is already locked in.",
        );
        requireThat(
          typeof action.targetId === "string" &&
            round.candidates.includes(action.targetId),
          "Choose an eligible suspect.",
        );
        requireThat(
          action.targetId !== playerId,
          "You cannot vote for yourself.",
        );
        round.votes.set(playerId, action.targetId);
        if (round.votes.size === round.participants.length)
          this.closeVote(room);
        break;
      case "guess": {
        inPhase("guess");
        participant();
        requireThat(
          round.imposterId === playerId,
          "Only the accused imposter can make the final guess.",
        );
        requireThat(
          typeof action.guess === "string" &&
            action.guess.trim().length > 0 &&
            action.guess.length <= 100,
          "Enter one guess of up to 100 characters.",
        );
        const guess = action.guess.trim();
        requireThat(
          normalizeGuess(guess).length > 0,
          "Your guess needs at least one letter or number.",
        );
        const accepted = [round.word.word, ...round.word.accepted].map(
          normalizeGuess,
        );
        this.finish(
          room,
          accepted.includes(normalizeGuess(guess)) ? "imposter" : "group",
          accepted.includes(normalizeGuess(guess))
            ? "The imposter guessed the secret word."
            : "The group caught the imposter. Their guess missed.",
          guess,
        );
        break;
      }
      case "leave":
        this.removePlayer(room, playerId, "left the room");
        break;
      default:
        throw new Error("Unknown game action.");
    }
    room.revision++;
    if (!this.receipts.has(playerId)) this.receipts.set(playerId, new Map());
    const playerReceipts = this.receipts.get(playerId);
    playerReceipts.set(action.actionId, this.now());
    if (playerReceipts.size > MAX_RECEIPTS_PER_PLAYER)
      playerReceipts.delete(playerReceipts.keys().next().value);
    return this.roomFor(playerId);
  }

  eligible(room, playerId) {
    return Boolean(
      room.round?.participants.includes(playerId) &&
      !room.round.ineligible.has(playerId) &&
      !room.players.get(playerId)?.departed,
    );
  }

  start(room) {
    const participants = [...room.players.values()]
      .filter((player) => player.connected && !player.departed)
      .map((player) => player.id);
    requireThat(
      participants.length >= 4 && participants.length <= 10,
      "You need 4–10 connected players to start.",
    );
    requireThat(
      room.categories.length > 0,
      "Choose at least one category first.",
    );
    const selectedPool = WORDS.filter((word) =>
      room.categories.includes(word.category),
    );
    let available = selectedPool.filter((word) => !room.usedWords.has(word.id));
    if (!available.length) {
      for (const word of selectedPool) room.usedWords.delete(word.id);
      available = selectedPool;
    }
    const word = available[this.randomInt(available.length)];
    const imposterId = participants[this.randomInt(participants.length)];
    const order = [...participants];
    for (let index = order.length - 1; index > 0; index--) {
      const selected = this.randomInt(index + 1);
      [order[index], order[selected]] = [order[selected], order[index]];
    }
    // Preserve departed roster entries through results, then clear them for the next round.
    for (const [id, player] of room.players)
      if (player.departed) room.players.delete(id);
    room.usedWords.add(word.id);
    room.roundId++;
    room.roundNumber++;
    room.phase = "reveal";
    room.notice = null;
    room.round = {
      participants,
      ineligible: new Set(),
      word,
      imposterId,
      order,
      ready: new Set(),
      lap: 1,
      turnIndex: 0,
      turnVersion: 1,
      paused: false,
      phaseDeadline: this.now() + 120_000,
      votes: new Map(),
      candidates: [],
      runoff: false,
      ballots: [],
      accusedId: null,
      result: null,
    };
  }

  turnId(room) {
    return `${room.roundId}:${room.round.turnVersion}`;
  }

  votingId(room) {
    return `${room.roundId}:ballot:${room.round.runoff ? 2 : 1}`;
  }

  advance(room) {
    room.round.turnIndex++;
    room.round.turnVersion++;
    room.round.paused = false;
    if (room.round.turnIndex >= room.round.order.length)
      room.phase = "discussion";
  }

  openVote(room, candidates, runoff) {
    room.phase = runoff ? "runoff" : "voting";
    room.round.candidates = [...candidates];
    room.round.runoff = runoff;
    room.round.votes = new Map();
    room.round.phaseDeadline = this.now() + 90_000;
  }

  closeVote(room) {
    const round = room.round;
    const totals = new Map(round.candidates.map((id) => [id, 0]));
    round.ballots.push({
      runoff: round.runoff,
      votes: round.participants.map((voterId) => ({
        voterId,
        targetId: round.votes.get(voterId),
      })),
    });
    for (const targetId of round.votes.values())
      totals.set(targetId, totals.get(targetId) + 1);
    const highest = Math.max(...totals.values());
    const leaders = [...totals]
      .filter(([, count]) => count === highest)
      .map(([id]) => id);
    if (leaders.length > 1) {
      if (round.runoff)
        this.finish(room, "imposter", "The runoff tied. The imposter escaped.");
      else this.openVote(room, leaders, true);
    } else {
      round.accusedId = leaders[0];
      if (round.accusedId === round.imposterId) {
        room.phase = "guess";
        round.phaseDeadline = this.now() + 60_000;
      } else
        this.finish(room, "imposter", "The group accused an innocent player.");
    }
  }

  finish(room, winner, reason, guess) {
    room.phase = "results";
    room.round.phaseDeadline = null;
    room.round.result = {
      winner,
      reason,
      word: room.round.word.word,
      imposterId: room.round.imposterId,
      ...(guess !== undefined ? { guess } : {}),
      ballots: copyBallots(room.round.ballots),
    };
  }

  removePlayer(room, playerId, reason) {
    const player = room.players.get(playerId);
    if (!player || player.departed) return;
    if (
      ACTIVE_PHASES.has(room.phase) &&
      room.round.participants.includes(playerId)
    ) {
      this.finish(
        room,
        null,
        `Round abandoned: ${player.nickname} ${reason}. Everyone can play again next round.`,
      );
    }
    player.connected = false;
    player.departed = true;
    player.disconnectDeadline = null;
    this.memberships.delete(playerId);
    if (!room.round?.participants.includes(playerId))
      room.players.delete(playerId);
    this.transferHost(room);
    if (![...room.players.values()].some((member) => !member.departed))
      room.emptySince ??= this.now();
  }

  sweep() {
    const now = this.now();
    for (const [code, room] of this.rooms) {
      const expired = [...room.players.values()].filter(
        (player) =>
          !player.departed &&
          !player.connected &&
          player.disconnectDeadline !== null &&
          player.disconnectDeadline <= now,
      );
      for (const player of expired) {
        this.removePlayer(
          room,
          player.id,
          "did not reconnect before their seat expired",
        );
        room.revision++;
      }
      // Seat expiration takes priority over phase deadlines, avoiding role-dependent
      // outcomes when a disconnected imposter's grace and guess timer expire together.
      if (
        ACTIVE_PHASES.has(room.phase) &&
        room.round.phaseDeadline !== null &&
        room.round.phaseDeadline <= now
      ) {
        if (room.phase === "guess")
          this.finish(room, "group", "The imposter ran out of time to guess.");
        else if (room.phase === "reveal")
          this.finish(
            room,
            null,
            "Round abandoned: not everyone readied up before the timer ended.",
          );
        else if (room.phase === "voting" || room.phase === "runoff")
          this.finish(
            room,
            null,
            "Round abandoned: the ballot deadline passed with missing votes.",
          );
        room.revision++;
      }
      if (room.emptySince !== null && now - room.emptySince >= EMPTY_ROOM_TTL)
        this.rooms.delete(code);
    }
    for (const [playerId, receipts] of this.receipts) {
      for (const [id, time] of receipts)
        if (now - time >= RECEIPT_TTL) receipts.delete(id);
      if (!receipts.size) this.receipts.delete(playerId);
    }
  }

  view(playerId) {
    const room = this.roomFor(playerId);
    if (!room) return null;
    const round = room.round;
    const eligible = this.eligible(room, playerId);
    const me = {
      id: playerId,
      isHost: room.hostId === playerId,
      ready: eligible && round.ready.has(playerId),
      hasVoted: eligible && round.votes.has(playerId),
      eligible,
    };
    if (eligible) {
      me.role = round.imposterId === playerId ? "imposter" : "insider";
      me.category = round.word.category;
      if (me.role === "insider" || room.phase === "results")
        me.word = round.word.word;
    }
    const inVote = room.phase === "voting" || room.phase === "runoff";
    return {
      code: room.code,
      hostId: room.hostId,
      phase: room.phase,
      roundNumber: room.roundNumber,
      roundId: room.roundId,
      revision: room.revision,
      categories: [...room.categories],
      lap: round?.lap ?? 0,
      players: [...room.players.values()].map((player) => ({
        id: player.id,
        nickname: player.nickname,
        avatar: player.avatar,
        connected: player.connected,
        waiting: Boolean(round && !this.eligible(room, player.id)),
        ready: Boolean(
          round && this.eligible(room, player.id) && round.ready.has(player.id),
        ),
        departed: player.departed,
        disconnectDeadline: player.disconnectDeadline,
      })),
      me,
      turn:
        room.phase === "clues"
          ? {
              id: this.turnId(room),
              currentId: round.order[round.turnIndex],
              nextId: round.order[round.turnIndex + 1] ?? null,
              finishedIds: round.order.slice(0, round.turnIndex),
              order: [...round.order],
              lap: round.lap,
              paused: round.paused,
            }
          : null,
      voting: inVote
        ? {
            id: this.votingId(room),
            submitted: round.votes.size,
            total: round.participants.length,
            candidateIds: [...round.candidates],
            runoff: round.runoff,
            deadline: round.phaseDeadline,
          }
        : null,
      phaseDeadline: round?.phaseDeadline ?? null,
      ballots: round ? copyBallots(round.ballots) : [],
      ...(round?.accusedId ? { accusedId: round.accusedId } : {}),
      ...(round?.result
        ? {
            result: {
              ...round.result,
              ballots: copyBallots(round.result.ballots),
            },
          }
        : {}),
      notice: room.notice,
    };
  }
}
