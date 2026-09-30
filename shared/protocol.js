/** Public, platform-neutral protocol helpers. Never place words, roles or sessions here. */
export const PROTOCOL_VERSION = 1;

export const CONNECTION_ERRORS = Object.freeze({
  sessionExpired: "SESSION_EXPIRED",
  tooManyTabs: "TOO_MANY_TABS",
});

export const GAME_TIMING = Object.freeze({
  disconnectGraceMs: 120_000,
  revealMs: 120_000,
  voteMs: 90_000,
  guessMs: 60_000,
});

/**
 * @typedef {'categories'|'start'|'ready'|'done'|'pause'|'advance'|'extra-lap'|'vote-start'|'vote'|'guess'|'leave'} ActionType
 * @typedef {Object} ActionEnvelope
 * @property {ActionType} type
 * @property {string} actionId Unique retry identifier, scoped to the authenticated seat.
 * @property {string} code Room identity; membership always comes from the server session.
 * @property {number} [roundId]
 * @property {string} [turnId]
 * @property {string} [votingId]
 * @property {string[]} [categories]
 * @property {string} [targetId]
 * @property {string} [guess]
 * @property {boolean} [paused]
 */

/** Basic reusable shape validation. The server still checks every game permission. */
export function assertActionEnvelope(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new Error("That action is not valid.");
  }
  if (
    typeof action.actionId !== "string" ||
    action.actionId.length < 1 ||
    action.actionId.length > 100
  ) {
    throw new Error(
      "This action needs a unique action ID. Please refresh and try again.",
    );
  }
}

/** Build an action from a recipient snapshot, without inferring authority locally. */
export function createActionEnvelope(snapshot, type, actionId, payload = {}) {
  const action = {
    ...payload,
    type,
    actionId,
    code: snapshot.code,
    roundId: snapshot.roundId,
    turnId: snapshot.turn?.id,
    votingId: snapshot.voting?.id,
  };
  assertActionEnvelope(action);
  return action;
}

/** The same room code can be used by a web URL, an app link, or a join form. */
export function normalizeRoomCode(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}
