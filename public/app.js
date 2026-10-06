import { avatar, describeAvatar, lookOf } from "./avatars.js";
import { AVATAR_PARTS, normalizeAvatar, randomAvatar } from "/shared/avatar.js";
import {
  afterRender,
  deviceReducesMotion,
  motionMode,
  play,
  setMotionPreference,
  transition,
} from "./motion.js";
import {
  setScene,
  setSoundEnabled,
  sfx,
  soundEnabled,
  unlock as unlockSound,
} from "./sound.js";
import {
  CONNECTION_ERRORS,
  GAME_TIMING,
  createActionEnvelope,
  normalizeRoomCode,
} from "/shared/protocol.js";

const app = document.querySelector("#app");
const status = document.querySelector("#connection");
const toast = document.querySelector("#toast");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
// randomUUID requires a secure context; getRandomValues also works on local LAN HTTP.
const actionId = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
let state = null,
  socket,
  connected = false,
  synced = false,
  catalog = [],
  busy = false,
  revealed = false,
  selectedVote = "",
  toastTimer;
let syncPending = false;
let connectionIssue = "";
let lastRenderKey = "";
let nickname = "",
  look = randomAvatar(),
  mode = new URLSearchParams(location.search).has("room") ? "join" : "create";
let roomCode = new URLSearchParams(location.search).get("room") || "",
  guess = "";
try {
  nickname = localStorage.getItem("alibi.nickname") || "";
  const saved = localStorage.getItem("alibi.avatar");
  if (saved !== null) {
    // Older versions stored a number 0 to 7; newer ones store the builder JSON.
    const parsed = /^\d+$/.test(saved) ? Number(saved) : JSON.parse(saved);
    look = normalizeAvatar(parsed) || look;
  }
} catch {
  /* Preferences are optional. */
}
const name = (id) =>
  state?.players.find((p) => p.id === id)?.nickname || "Departed player";
const cat = (id) => {
  const category = catalog.find((c) => c.id === id);
  return category
    ? `${category.plainLabel || category.label} · ${category.label}`
    : id || "Mystery";
};
const graceLabel = () => {
  const seconds =
    (state?.disconnectGraceMs || GAME_TIMING.disconnectGraceMs) / 1000;
  return `${seconds / 60} minutes (${seconds} seconds)`;
};
const disabled = (condition) =>
  condition || busy || !connected || !synced ? "disabled" : "";
const button = (text, action, options = "") =>
  `<button type="button" class="button" data-action="${action}" ${disabled(false)} ${options}>${text}</button>`;
const timer = (deadline) =>
  deadline ? `<span class="deadline" data-deadline="${deadline}"></span>` : "";
const rules = () =>
  `<details class="rules"><summary>First time in the hot seat? <span>How to play</span></summary><div class="rules-content"><p><b>1. Keep your card private.</b> Everyone gets a secret word, except one imposter who gets only the category.</p><p><b>2. Give a clue aloud.</b> Take turns on your Discord or voice call. Be specific enough to fit in, vague enough to protect the word.</p><p><b>3. Find the imposter.</b> Discuss and vote privately. A caught imposter gets one chance to guess the word and steal the win.</p><p>One runoff breaks a tie. A second tie or an innocent accusation lets the imposter escape.</p></div></details>`;

function notify(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 6500);
}

function setup() {
  return `<section class="entry-grid"><div class="entry-story"><div class="eyebrow"><span class="orange-line"></span> A PARTY GAME OF PLAUSIBLE DENIABILITY</div><h1>Good friends.<br>Bad <em>alibis.</em></h1><p class="intro">Everyone knows the secret word.<br>Well, <span>almost</span> everyone.</p><div class="art-frame"><picture><source srcset="/art/interrogation.webp" type="image/webp"><img class="hero-art" src="/art/interrogation.png" alt="Four suspicious characters around an interrogation table under an orange spotlight"></picture><span class="art-caption">SOMEONE AT THIS TABLE IS WINGING IT.</span></div></div><div class="entry-right"><section class="paper entry-card"><div class="paper-top"><span class="eyebrow">THE NIGHT STARTS HERE</span><span class="tiny-stamp">TOP SECRET</span></div><h2>Take a seat.</h2><p class="muted">Gather your friends. Bring your poker face.</p><div class="tabs" role="group" aria-label="Choose how to play"><button type="button" data-mode="create" class="${mode === "create" ? "selected" : ""}" aria-pressed="${mode === "create"}">Create a room</button><button type="button" data-mode="join" class="${mode === "join" ? "selected" : ""}" aria-pressed="${mode === "join"}">Join a room</button></div><form id="entry-form"><label for="nickname">What should we call you?</label><input id="nickname" name="nickname" placeholder="Your nickname" maxlength="20" minlength="1" autocomplete="nickname" value="${esc(nickname)}" required>${builder()}${mode === "join" ? `<label for="room-code">Room code</label><input id="room-code" class="code-input" name="code" placeholder="ABCDEF" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(roomCode)}" required>` : ""}<button class="button primary wide" type="submit" ${disabled(false)}>${busy ? "Pulling up your chair…" : mode === "join" ? "Join the room" : "Create a private room"}</button><p class="form-note">No accounts. Just a room link and your friends.</p></form></section><div class="voice-note"><span class="headphones" aria-hidden="true">◖◗</span><div><b>Bring your own conversation.</b><p>Hop on Discord or your favorite voice call.<br>We’ll handle the secrets.</p></div></div></div></section><div class="entry-bottom"><div><span class="step-number">01</span><b>Get your secret</b></div><div><span class="step-number">02</span><b>Sound convincing</b></div><div><span class="step-number">03</span><b>Call their bluff</b></div></div>${rules()}`;
}

// The avatar builder: a live preview, Randomize, and one row per part. Option
// previews show your current suspect with just that part changed. Swatches
// are SVG because the page's CSP does not allow inline style attributes.
const PART_LABELS = {
  color: "Color",
  face: "Face",
  hat: "Hat",
  glasses: "Glasses",
  mustache: "Mustache",
};
function builder() {
  const swatch = (hex) =>
    `<svg class="swatch" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="8" fill="${hex}"/></svg>`;
  return `<fieldset class="avatar-builder"><legend>Build your suspect</legend><div class="builder-top"><div class="builder-preview" role="img" aria-label="Your suspect: ${esc(describeAvatar(look))}">${avatar(look, "preview")}</div><button type="button" class="button small quiet" data-randomize><span class="die" aria-hidden="true">⚄</span> Randomize</button></div>${Object.entries(
    AVATAR_PARTS,
  )
    .map(
      ([part, options]) =>
        `<div class="builder-row" role="group" aria-label="${PART_LABELS[part]}"><span class="builder-label" aria-hidden="true">${PART_LABELS[part]}</span><div class="builder-options">${options
          .map(
            (option, i) =>
              `<button type="button" class="builder-option ${look[part] === i ? "selected" : ""}" data-part="${part}" data-value="${i}" aria-pressed="${look[part] === i}" aria-label="${esc(option.label)}">${part === "color" ? swatch(option.value) : avatar({ ...look, [part]: i }, "mini")}</button>`,
          )
          .join("")}</div></div>`,
    )
    .join("")}</fieldset>`;
}

function roomHeader() {
  return `<div class="room-bar"><div><span class="eyebrow">PRIVATE ROOM</span><button type="button" class="room-code" data-copy aria-label="Copy room invite link">${esc(state.code)} <span aria-hidden="true">⧉</span></button></div><div class="room-actions"><button type="button" class="button small quiet" data-copy>Copy invite link</button><button type="button" class="text-button" data-action="leave" ${disabled(false)}>Leave room</button></div></div>${state.notice ? `<div class="notice" role="status">${esc(state.notice)}</div>` : ""}${
    state.players.some((p) => !p.connected && !p.departed)
      ? `<div class="notice warning">${state.players
          .filter((p) => !p.connected && !p.departed)
          .map(
            (p) =>
              `${esc(p.nickname)} is reconnecting ${timer(p.disconnectDeadline)}`,
          )
          .join(
            " · ",
          )}. Seats are held for ${graceLabel()}. Round deadlines still apply.</div>`
      : ""
  }`;
}

function playerGrid() {
  const connectedCount = state.players.filter(
    (p) => p.connected && !p.departed,
  ).length;
  const players = state.players.filter((p) => !p.departed);
  return `<section class="players-section"><div class="section-title"><h3>The usual suspects</h3><span>${connectedCount}<span class="dim"> / 10</span></span></div><div class="players-grid">${players.map((p) => `<div class="player-tile ${p.connected ? "" : "disconnected"}" data-player="${esc(p.id)}">${avatar(p.avatar)}<div><b>${esc(p.nickname)}${p.id === state.me.id ? ' <span class="you">you</span>' : ""}</b><span class="player-status">${p.id === state.hostId ? "Host" : p.waiting ? "Next round" : p.connected ? "In the room" : "Reconnecting…"}</span>${tally(p.id)}</div>${p.connected ? '<span class="online-dot" aria-label="Connected"></span>' : ""}</div>`).join("")}${Array.from({ length: Math.max(0, 4 - players.length) }, () => `<div class="player-tile empty"><div class="empty-avatar">?</div><span>Saving a seat…</span></div>`).join("")}</div><div class="room-tip"><span aria-hidden="true">✳</span><p>${connectedCount < 4 ? `Need ${4 - connectedCount} more ${4 - connectedCount === 1 ? "friend" : "friends"} to start. Send them your invite link.` : "The table is ready. Make sure everyone is on the voice call."}</p></div></section>`;
}

function categories() {
  return `<div class="category-list">${catalog.map((c, i) => `<label class="category ${state.categories.includes(c.id) ? "checked" : ""}"><input type="checkbox" name="category" value="${esc(c.id)}" ${state.categories.includes(c.id) ? "checked" : ""} ${disabled(!state.me.isHost)}><span class="category-icon" aria-hidden="true">${["✦", "◒", "♧", "⌂", "◎", "♫", "◈", "✳"][i % 8]}</span><span class="category-copy"><b>${esc(c.label)}</b><small class="category-plain">${esc(c.plainLabel || c.label)}</small><small class="category-description">${esc(c.description || "")}</small></span><span class="check" aria-hidden="true">${state.categories.includes(c.id) ? "✓" : "+"}</span></label>`).join("")}</div>`;
}

function lobby() {
  const total = state.players.filter((p) => p.connected && !p.departed).length;
  return `${roomHeader()}<div class="room-heading"><div class="eyebrow">MAKE YOURSELF SUSPICIOUS</div><h1 id="phase-title" tabindex="-1">The waiting room<span class="orange">.</span></h1><p>Everyone’s a friend. For now.</p></div><div class="lobby-grid"><div>${playerGrid()}<div class="lobby-art"><picture><source srcset="/art/interrogation.webp" type="image/webp"><img src="/art/interrogation.png" alt="A lineup of four very suspicious friends"></picture><span>TRUST IS A BEAUTIFUL THING.<br>LET’S RUIN IT A LITTLE.</span></div></div><section class="paper case-settings"><div class="paper-top"><span class="eyebrow">TONIGHT’S CASE FILE</span><span class="tiny-stamp">CLASSIFIED</span></div><h2>Pick your territory.</h2><p class="muted">${state.me.isHost ? "Choose at least one category for the secret word." : "Your host is choosing the categories."}</p>${categories()}<div class="settings-bottom"><div class="settings-line"><span>Imposters</span><b>1 very good liar</b></div><div class="settings-line"><span>Clue laps</span><b>1 + an optional encore</b></div>${state.me.isHost ? `<button class="button primary wide" data-action="start" ${disabled(total < 4 || !state.categories.length)}>${total < 4 ? "Waiting for more players" : "Start the round"}</button>` : `<div class="waiting-label">Waiting for ${esc(name(state.hostId))} to start</div>`}</div></section></div>${rules()}`;
}

function phaseSteps() {
  const phase = state.phase;
  const index =
    phase === "reveal"
      ? 0
      : phase === "clues"
        ? 1
        : phase === "discussion"
          ? 2
          : ["voting", "runoff", "guess"].includes(phase)
            ? 3
            : 4;
  return `<div class="phase-steps" aria-label="Round progress">${["The secret", "The clues", "The debate", "The verdict"].map((s, i) => `<div class="${i === index ? "active" : i < index ? "complete" : ""}" ${i === index ? 'aria-current="step"' : ""}><span>${i < index ? "✓" : `0${i + 1}`}</span>${s}</div>`).join("")}</div>`;
}

function privateCard() {
  if (!state.me.role || state.phase === "results") return "";
  const imposter = state.me.role === "imposter";
  return `<section class="paper private-card"><div class="paper-top"><span class="eyebrow">FOR YOUR EYES ONLY</span><span aria-hidden="true">◈</span></div>${revealed ? `<div class="role-content ${imposter ? "imposter" : ""}"><span class="role-label">${imposter ? "YOU ARE THE IMPOSTER" : "YOU KNOW THE WORD"}</span><h2>${imposter ? "Play it cool." : esc(state.me.word)}</h2><p>Category: <b>${esc(cat(state.me.category))}</b></p><p class="role-hint">${imposter ? "Listen closely. Blend in. The word is your way out." : "Give a clue without giving the whole game away."}</p></div>` : `<div class="concealed"><div class="secret-symbol" aria-hidden="true">?</div><h3>A little secret.</h3><p>Make sure only you can see your screen.</p></div>`}<button type="button" class="button reveal-button wide" data-reveal aria-pressed="${revealed}">${revealed ? "Hide my card" : "Reveal my card"}</button><p class="card-footnote">Your card hides when you leave this tab.</p></section>`;
}

function turnList() {
  const ids =
    state.turn?.order ||
    state.players.filter((p) => !p.waiting).map((p) => p.id);
  return `<section class="turn-list"><div class="section-title"><h3>${state.phase === "clues" ? "Speaking order" : "Around the table"}</h3>${state.turn ? `<span>Lap ${state.turn.lap}</span>` : ""}</div>${ids
    .map((id, i) => {
      const p = state.players.find((p) => p.id === id);
      if (!p) return "";
      const current = state.phase === "clues" && state.turn?.currentId === id,
        done = state.turn?.finishedIds.includes(id);
      return `<div class="turn-row ${current ? "current" : ""}"><span class="order-number">${done ? "✓" : String(i + 1).padStart(2, "0")}</span>${avatar(p.avatar, "mini")}<b>${esc(p.nickname)}${id === state.me.id ? ' <span class="you">you</span>' : ""}</b><span class="turn-status">${!p.connected ? "Offline" : current ? "Speaking" : state.phase === "reveal" ? (p.ready ? "Ready" : "Checking card") : done ? "Done" : ""}</span></div>`;
    })
    .join("")}</section>`;
}

function mainStage() {
  const s = state;
  const waiting = !s.me.eligible;
  if (s.phase === "reveal")
    return `<section class="stage"><div class="stage-icon" aria-hidden="true">◈</div><span class="eyebrow">ROUND ${s.roundNumber} · EYES DOWN</span><h1 id="phase-title" tabindex="-1">${waiting ? "Your seat is saved." : s.me.ready ? "Poker face on." : "Got a good alibi?"}</h1><p>${waiting ? "You arrived mid-case. Watch this round, then join the next one." : s.me.ready ? "Keep your secret. We’re waiting for everyone to be ready." : "Reveal your private card, remember it, then tell us you’re ready."}</p><div class="readiness">${s.players.filter((p) => p.ready && !p.waiting).length} / ${s.players.filter((p) => !p.waiting && !p.departed).length} ready ${timer(s.phaseDeadline)}</div>${!waiting ? `<button class="button primary" data-action="ready" ${disabled(s.me.ready)}>${s.me.ready ? "You’re ready" : "I’m ready"}</button>` : ""}</section>`;
  if (s.phase === "clues") {
    const current = s.players.find((p) => p.id === s.turn.currentId);
    const yours = s.turn.currentId === s.me.id;
    return `<section class="stage speaker-stage ${s.turn.paused ? "paused" : ""}"><span class="eyebrow">ROUND ${s.roundNumber} · CLUE LAP ${s.turn.lap}</span><div class="spotlight">${avatar(current?.avatar, "speaker-avatar")}</div><div class="speaking-label">${s.turn.paused ? "ON HOLD" : yours ? "YOU’RE IN THE HOT SEAT" : "IN THE HOT SEAT"}</div><h1 id="phase-title" tabindex="-1">${s.turn.paused ? "A dramatic pause." : yours ? "Your turn." : `Waiting for ${esc(current?.nickname)}.`}</h1><p>${s.turn.paused ? "Your host will resume the round shortly." : yours ? "Give one short clue aloud. Sound like you belong." : "Listen to the clue. Notice anything suspicious?"}</p>${yours ? `<button class="button primary" data-action="done" ${disabled(s.turn.paused)}>Done with my clue</button>` : `<div class="waiting-label">${s.turn.paused ? "Take a breath." : `${esc(current?.nickname)} is giving a clue…`}</div>`}<div class="up-next">UP NEXT <b>${s.turn.nextId ? esc(name(s.turn.nextId)) : "Everyone · discussion"}</b></div></section>${s.me.isHost ? `<div class="host-controls"><span>HOST CONTROLS</span>${button(s.turn.paused ? "Resume round" : "Pause round", "pause")}${button("Advance turn", "advance")}</div>` : ""}`;
  }
  if (s.phase === "discussion")
    return `<section class="stage"><div class="stage-icon" aria-hidden="true">“ ”</div><span class="eyebrow">LET’S HEAR YOUR THEORY</span><h1 id="phase-title" tabindex="-1">Something doesn’t<br>add up.</h1><p>Compare clues on your voice call.<br>Who’s bluffing, and who’s just bad at clues?</p>${s.me.isHost ? `<div class="stage-actions">${button("Start private voting", "vote-start", "data-primary")}${s.lap < 2 ? button("One more clue lap", "extra-lap") : ""}</div>` : `<div class="waiting-label">${esc(name(s.hostId))} will start the vote.</div>`}</section>`;
  if (["voting", "runoff"].includes(s.phase))
    return `<section class="stage vote-stage"><span class="eyebrow">${s.voting.runoff ? "ONE LAST CHANCE TO AGREE" : "NO PEEKING. NO SELF-VOTES."}</span><h1 id="phase-title" tabindex="-1">${s.voting.runoff ? "Let’s break the tie." : "Who’s the imposter?"}</h1><p>${waiting ? "Watch the verdict. You’ll play next round." : s.me.hasVoted ? "Your vote is locked. Let’s see if your instincts were right." : "Choose your suspect. Your vote stays private until everyone is in."}</p><div class="vote-progress"><b>${s.voting.submitted} / ${s.voting.total}</b> votes locked ${timer(s.voting.deadline)}</div><div class="vote-grid">${s.voting.candidateIds
      .map((id) => {
        const p = s.players.find((p) => p.id === id);
        return `<button type="button" class="vote-candidate ${selectedVote === id ? "selected" : ""}" data-vote="${id}" aria-pressed="${selectedVote === id}" ${disabled(waiting || s.me.hasVoted || id === s.me.id)}>${avatar(p?.avatar)}<b>${esc(p?.nickname)}</b><span>${id === s.me.id ? "That’s you" : selectedVote === id ? "Your suspect" : "Suspect"}</span></button>`;
      })
      .join(
        "",
      )}</div>${!waiting ? `<button type="button" class="button primary" data-submit-vote ${disabled(!selectedVote || s.me.hasVoted)}>${s.me.hasVoted ? "Vote locked" : "Lock in my vote"}</button>` : ""}<p class="fineprint">An incomplete ballot ends the round without a winner.</p></section>${ballots(s.ballots)}`;
  if (s.phase === "guess")
    return `<section class="stage"><span class="eyebrow">THE FINAL ALIBI</span><div class="stage-icon" aria-hidden="true">!</div><h1 id="phase-title" tabindex="-1">Caught. Not finished.</h1><p><b>${esc(name(s.accusedId))}</b> is the imposter.<br>${s.me.role === "imposter" ? "Guess the secret word to steal the win. One shot." : "They get one chance to guess the secret word. Keep it to yourself."}</p>${timer(s.phaseDeadline)}${s.me.role === "imposter" ? `<form id="guess-form" class="guess-form"><label for="guess">Your final guess</label><input id="guess" maxlength="80" autocomplete="off" placeholder="Make it count…" value="${esc(guess)}" required><button class="button primary wide" ${disabled(false)}>Submit final guess</button></form>` : `<div class="waiting-label">Waiting for the final guess…</div>`}</section>${ballots(s.ballots)}`;
  return "";
}

// Votes each suspect got on the deciding ballot, shown only once results are
// public (ballots are already revealed there).
function tally(id) {
  const final =
    state.phase === "results" ? state.result?.ballots?.at(-1) : null;
  if (!final) return "";
  const count = final.votes.filter((v) => v.targetId === id).length;
  if (!count) return "";
  return `<span class="tally" aria-label="${count} ${count === 1 ? "vote" : "votes"}">${'<i aria-hidden="true"></i>'.repeat(count)}</span>`;
}

function ballots(items) {
  if (!items?.length) return "";
  return `<details class="ballot-details" ${state.phase === "results" ? "open" : ""}><summary>The votes, unsealed <span>${items.length} ballot${items.length === 1 ? "" : "s"}</span></summary>${items.map((b) => `<div class="ballot"><h3>${b.runoff ? "Runoff" : "First vote"}</h3>${b.votes.map((v) => `<div data-target="${esc(v.targetId)}"><span>${esc(name(v.voterId))}</span><span class="dim">voted for</span><b>${esc(name(v.targetId))}</b></div>`).join("")}</div>`).join("")}</details>`;
}

function results() {
  const r = state.result;
  const title =
    r.winner === "group"
      ? "Case closed."
      : r.winner === "imposter"
        ? "A clean getaway."
        : "Case interrupted.";
  return `${roomHeader()}<section class="results-heading"><span class="eyebrow">ROUND ${state.roundNumber} · ${r.winner ? "THE TRUTH IS OUT" : "NO WINNER"}</span><h1 id="phase-title" tabindex="-1">${title}</h1><p>${r.winner === "group" ? "The group wins. Good instincts, detectives." : r.winner === "imposter" ? "The imposter wins. Maybe trust a little less next time." : "The round ended so everyone can start together again."}</p></section><div class="results-grid"><section class="paper result-card"><span class="tiny-stamp">${r.winner === "group" ? "SOLVED" : r.winner === "imposter" ? "ESCAPED" : "INTERRUPTED"}</span><span class="eyebrow">THE SECRET WORD WAS</span><h2>${esc(r.word)}</h2><div class="reveal-imposter">${avatar(state.players.find((p) => p.id === r.imposterId)?.avatar)}<div><small>THE IMPOSTER</small><b>${esc(name(r.imposterId))}</b></div></div><p class="result-reason">${esc(r.reason)}</p>${r.guess ? `<p class="final-guess">Final guess: <b>“${esc(r.guess)}”</b></p>` : ""}</section><div class="result-next"><h2>Another round?<br>Another alibi.</h2><p>Same friends. A fresh secret.<br>Everyone’s back in the game.</p>${state.me.isHost ? `<button class="button primary" data-action="start" ${disabled(state.players.filter((p) => p.connected && !p.departed).length < 4 || !state.categories.length)}>Next round</button>${state.players.filter((p) => p.connected && !p.departed).length < 4 ? '<p class="fineprint">You need at least 4 connected players.</p>' : ""}` : `<div class="waiting-label">Waiting for ${esc(name(state.hostId))} to start.</div>`}<details class="next-categories"><summary>Categories for next round</summary>${categories()}</details></div></div>${ballots(r.ballots)}${playerGrid()}`;
}

function render() {
  const active = document.activeElement,
    activeId = active?.id;
  const activeKey = active?.dataset?.focusKey;
  const selection = active?.selectionStart;
  const renderKey = `${state?.code}:${state?.roundId}:${state?.phase}`;
  const detailsState =
    renderKey === lastRenderKey
      ? new Map(
          [...app.querySelectorAll("details")].map((el) => [
            el.className,
            el.open,
          ]),
        )
      : new Map();
  lastRenderKey = renderKey;
  status.className = `connection ${connected && synced ? "live" : "offline"}`;
  status.textContent = connectionIssue
    ? "Reload to reconnect"
    : connected && synced
      ? "Connected · let’s play"
      : connected
        ? "Updating your room…"
        : "Reconnecting…";
  const offline =
    !connected || !synced
      ? `<div class="connection-banner" role="status">${connectionIssue ? esc(connectionIssue) : `${connected ? "Checking the latest room state…" : "Reconnecting…"} ${state ? `While the server is running, your seat is held for ${graceLabel()} after it detects a lost connection. Round deadlines keep running.` : "Waiting for a connection to the game server."}`} <a data-reconnect href="${esc(location.pathname + location.search)}">Reload to try again</a>.</div>`
      : "";
  app.innerHTML =
    offline +
    (!state
      ? setup()
      : state.phase === "lobby"
        ? lobby()
        : state.phase === "results"
          ? results()
          : `${roomHeader()}${phaseSteps()}${!state.me.eligible ? '<div class="notice">You joined during a round. Your seat is saved for the next one.</div>' : ""}<div class="game-grid"><div>${mainStage()}</div><aside>${privateCard()}${turnList()}</aside></div>`);
  app.dataset.phase = state?.phase || "entry";
  arrangePhoneControls();
  const announcement =
    state?.phase === "clues"
      ? `${state.turn.paused ? "Round paused." : state.turn.currentId === state.me.id ? "Your turn to give a clue." : `Waiting for ${name(state.turn.currentId)} to give a clue.`}`
      : state?.voting
        ? `${state.voting.submitted} of ${state.voting.total} votes submitted.`
        : state?.phase === "reveal"
          ? `${state.players.filter((p) => p.ready && !p.waiting).length} players ready.`
          : "";
  const live = document.querySelector("#game-announcement");
  if (live.textContent !== announcement) live.textContent = announcement;
  app.querySelectorAll("details").forEach((el) => {
    if (detailsState.has(el.className))
      el.open = detailsState.get(el.className);
  });
  const keys = new Map();
  app.querySelectorAll("button,input,a,summary").forEach((el) => {
    const data = [...el.attributes]
      .filter((attr) => attr.name.startsWith("data-"))
      .map((attr) => `${attr.name}:${attr.value}`)
      .join("|");
    const base =
      el.id ||
      data ||
      (el.tagName === "SUMMARY"
        ? `summary:${el.parentElement.className}`
        : el.type === "submit"
          ? `submit:${el.form?.id}`
          : `${el.tagName}:${el.name || ""}:${el.value || ""}:${el.getAttribute("href") || ""}`);
    const count = keys.get(base) || 0;
    keys.set(base, count + 1);
    el.dataset.focusKey = `${base}:${count}`;
  });
  const next = activeId
    ? document.getElementById(activeId)
    : activeKey
      ? [...app.querySelectorAll("[data-focus-key]")].find(
          (el) => el.dataset.focusKey === activeKey,
        )
      : null;
  if (next && !next.disabled) {
    next.focus({ preventScroll: true });
    if (typeof selection === "number" && next.setSelectionRange)
      try {
        next.setSelectionRange(selection, selection);
      } catch {}
  } else if (activeKey)
    document.querySelector("#phase-title")?.focus({ preventScroll: true });
  updateTimers();
  afterRender(renderKey);
}

function updateTimers() {
  document.querySelectorAll("[data-deadline]").forEach((el) => {
    const seconds = Math.max(
      0,
      Math.ceil((Number(el.dataset.deadline) - Date.now()) / 1000),
    );
    el.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left`;
  });
}
setInterval(updateTimers, 1000);

async function send(event, payload) {
  if (!connected || !synced || busy) return;
  const focusKey = document.activeElement?.dataset?.focusKey;
  busy = true;
  render();
  return new Promise((resolve) =>
    socket.timeout(7000).emit(event, payload, (err, response) => {
      busy = false;
      if (err)
        notify(
          "No confirmation yet. Reconnect to see the latest room state before trying again.",
        );
      else if (!response?.ok)
        notify(response?.error || "That action could not be completed.");
      render();
      const control = [...app.querySelectorAll("[data-focus-key]")].find(
        (el) => el.dataset.focusKey === focusKey,
      );
      if (control && !control.disabled) control.focus({ preventScroll: true });
      resolve(!err && response?.ok);
    }),
  );
}
function act(type, extra = {}) {
  if (!state) return;
  return send("action", createActionEnvelope(state, type, actionId(), extra));
}

// Reposition the real control, preserving its handler and accessible name.
// The game itself remains entirely independent of screen size and platform.
const phoneLayout = matchMedia("(max-width: 760px)");
function arrangePhoneControls() {
  document.body.classList.remove("has-action-dock");
  if (!state || !phoneLayout.matches) return;
  if (state.phase === "reveal") {
    const card = app.querySelector(".private-card");
    if (card) app.querySelector(".game-grid > div")?.prepend(card);
  }
  const selector = {
    lobby: '[data-action="start"]',
    results: '[data-action="start"]',
    reveal: '[data-action="ready"]',
    clues: '[data-action="done"]',
    discussion: '[data-action="vote-start"]',
    // Voting and runoff keep "Lock in my vote" inline under the lineup: a
    // fixed dock would slide over suspects while scrolling a full room.
    guess: "#guess-form button",
  }[state.phase];
  const primary = selector && app.querySelector(selector);
  if (!primary) return;
  if (primary.form) primary.setAttribute("form", primary.form.id);
  const dock = document.createElement("div");
  dock.className = "action-dock";
  const caption = document.createElement("span");
  caption.className = "dock-caption";
  caption.textContent =
    state.phase === "clues"
      ? "Your turn · give your clue aloud"
      : state.phase === "reveal"
        ? "Read your private card first"
        : state.phase === "guess"
          ? "One final guess · enter it above"
          : "Same room. All your friends.";
  dock.append(caption, primary);
  app.append(dock);
  document.body.classList.add("has-action-dock");
}
phoneLayout.addEventListener("change", render);

function synchronize() {
  if (!socket || document.hidden || syncPending || connectionIssue) return;
  synced = false;
  revealed = false;
  render();
  if (!socket.connected) {
    socket.connect();
    return;
  }
  syncPending = true;
  socket.timeout(7000).emit("state:sync", {}, (error, reply) => {
    syncPending = false;
    if (error || !reply?.ok) {
      connectionIssue =
        reply?.error ||
        "Could not refresh the room. Reload before taking your turn.";
      render();
    }
  });
}

app.addEventListener("click", async (event) => {
  if (event.target.closest("[data-reconnect]")) {
    event.preventDefault();
    location.reload();
    return;
  }
  const el = event.target.closest("button");
  if (!el || el.disabled) return;
  if (el.dataset.mode) {
    mode = el.dataset.mode;
    render();
  } else if (el.dataset.part) {
    look = lookOf({ ...look, [el.dataset.part]: Number(el.dataset.value) });
    render();
    play("pick", lastRenderKey);
  } else if (el.hasAttribute("data-randomize")) {
    look = randomAvatar();
    render();
    play("randomize", lastRenderKey);
  } else if (el.hasAttribute("data-reveal")) {
    revealed = !revealed;
    render();
    if (revealed) play("card", lastRenderKey);
  } else if (el.dataset.vote) {
    selectedVote = el.dataset.vote;
    render();
    play("select", lastRenderKey);
  } else if (el.hasAttribute("data-submit-vote")) {
    await act("vote", { targetId: selectedVote });
  } else if (el.hasAttribute("data-copy")) {
    const invite = `${location.origin}/?room=${state.code}`;
    try {
      await navigator.clipboard.writeText(invite);
      notify("Invite link copied. Send it to your suspects.");
    } catch {
      notify(`Share this invite: ${invite}`);
    }
  } else if (el.dataset.action) {
    if (el.dataset.action === "ready") revealed = false;
    await act(
      el.dataset.action,
      el.dataset.action === "pause" ? { paused: !state.turn.paused } : {},
    );
  }
});
app.addEventListener("input", (event) => {
  if (event.target.id === "nickname") nickname = event.target.value;
  if (event.target.id === "room-code")
    roomCode = event.target.value.toUpperCase();
  if (event.target.id === "guess") guess = event.target.value;
});
app.addEventListener("change", (event) => {
  if (event.target.name === "category")
    act("categories", {
      categories: [
        ...document.querySelectorAll('input[name="category"]:checked'),
      ].map((el) => el.value),
    });
});
app.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "entry-form") {
    try {
      localStorage.setItem("alibi.nickname", nickname);
      localStorage.setItem("alibi.avatar", JSON.stringify(look));
    } catch {}
    await send(mode === "create" ? "room:create" : "room:join", {
      nickname: nickname.trim(),
      avatar: look,
      code: normalizeRoomCode(roomCode),
    });
  }
  if (event.target.id === "guess-form") await act("guess", { guess });
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    revealed = false;
    synced = false;
    render();
  } else synchronize();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) synchronize();
});
window.addEventListener("online", synchronize);
window.addEventListener("blur", () => {
  if (revealed) {
    revealed = false;
    render();
  }
});

// Sound cues for what just changed. Results cues line up with the results
// moment in motion.js (imposter turns at 0.85s, stamp lands at 1.49s); with
// reduced motion they play straight away.
function cue(next, previousPhase, previousSpeaker) {
  setScene({
    phase: next?.phase || "entry",
    votingRatio: next?.voting ? next.voting.submitted / next.voting.total : 0,
  });
  if (!next) return;
  const full = motionMode() === "full";
  if (next.phase !== previousPhase) {
    if (next.phase === "guess") sfx("accuse");
    if (next.phase === "results" && next.result) {
      const won = next.result.winner;
      if (won) sfx("sting", full ? 0.85 : 0);
      if (won === "imposter") sfx("escape", full ? 1.2 : 0.4);
      sfx("thud", full ? 1.49 : 0.5);
    }
  }
  const speaker = next.phase === "clues" ? next.turn?.currentId : undefined;
  if (
    speaker &&
    speaker === next.me?.id &&
    (speaker !== previousSpeaker || next.phase !== previousPhase)
  )
    sfx("turn", 0.15);
}

// Every press gets a sound: card reveal flips, locking a vote latches, the
// rest tick. The first press also starts audio (browsers require a gesture).
document.addEventListener("pointerdown", () => unlockSound(), {
  capture: true,
});
document.addEventListener("keydown", () => unlockSound(), { capture: true });
document.addEventListener(
  "click",
  (event) => {
    const el = event.target.closest("button, summary, .category");
    if (!el || el.disabled) return;
    if (el.id === "sound-toggle") return;
    if (el.hasAttribute("data-reveal")) sfx(revealed ? "tap" : "flip");
    else if (el.hasAttribute("data-submit-vote")) sfx("lock");
    else sfx("tap");
  },
  { capture: true },
);

const soundToggle = document.querySelector("#sound-toggle");
function syncSoundToggle() {
  if (!soundToggle) return;
  const on = soundEnabled();
  soundToggle.setAttribute("aria-pressed", String(on));
  soundToggle.querySelector("span").textContent = on ? "Sound on" : "Sound off";
  soundToggle.title = on ? "Mute game sounds" : "Turn game sounds on";
}
soundToggle?.addEventListener("click", () => {
  setSoundEnabled(!soundEnabled());
  syncSoundToggle();
  if (soundEnabled()) sfx("tap");
});
syncSoundToggle();

// Header motion toggle. It starts on whatever the device asks for and the
// player can override it; the choice is remembered on this device only.
const motionToggle = document.querySelector("#motion-toggle");
function syncMotionToggle() {
  if (!motionToggle) return;
  const full = motionMode() === "full";
  motionToggle.setAttribute("aria-pressed", String(full));
  motionToggle.querySelector("span").textContent = full
    ? "Motion on"
    : "Motion reduced";
  motionToggle.title = full
    ? "Animations are on. Tap for reduced motion."
    : deviceReducesMotion()
      ? "Your device asks for reduced motion, so only gentle fades play. Tap to turn full motion on."
      : "Only gentle fades play. Tap to turn full motion on.";
}
motionToggle?.addEventListener("click", () => {
  setMotionPreference(motionMode() === "full" ? "reduced" : "full");
  syncMotionToggle();
});
syncMotionToggle();

async function boot() {
  try {
    const response = await fetch("/api/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    socket = window.io({
      autoConnect: false,
      transports: ["websocket", "polling"],
      tryAllTransports: true,
      reconnectionDelay: 700,
      reconnectionDelayMax: 3000,
    });
    socket.on("connect", () => {
      connectionIssue = "";
      connected = true;
      synced = false;
      render();
    });
    socket.on("disconnect", (reason) => {
      connected = false;
      synced = false;
      syncPending = false;
      revealed = false;
      connectionIssue =
        reason === "io server disconnect"
          ? "The server closed your connection. Reload to connect again. Your session may have expired."
          : "";
      render();
    });
    socket.on("connect_error", (error) => {
      connected = false;
      synced = false;
      revealed = false;
      // Authentication rejections stop Socket.IO retries; preserve an actionable
      // message instead of claiming an automatic reconnect is still in progress.
      connectionIssue =
        error.data?.code === CONNECTION_ERRORS.sessionExpired ||
        error.data?.code === CONNECTION_ERRORS.tooManyTabs ||
        !socket.active
          ? error.message || "Connection refused. Reload to try again."
          : "";
      render();
    });
    socket.on("catalog", (items) => {
      catalog = items;
      render();
    });
    socket.on("state", (next) => {
      connectionIssue = "";
      synced = true;
      const previousPhase = state?.phase,
        previousRound = state?.roundId,
        previousSpeaker =
          state?.phase === "clues" ? state.turn?.currentId : undefined;
      const phaseChanged =
        next?.roundId !== previousRound || next?.phase !== previousPhase;
      if (phaseChanged) {
        revealed = false;
        selectedVote = "";
        guess = "";
      }
      const apply = () => {
        state = next;
        if (state) {
          history.replaceState(null, "", `/?room=${state.code}`);
        } else if (previousPhase) {
          history.replaceState(null, "", "/");
          roomCode = "";
        }
        render();
        if (state?.phase !== previousPhase) {
          // A new phase starts at its heading, not wherever the last one was
          // scrolled to (phones kept the old position before).
          if (previousPhase) scrollTo({ top: 0, behavior: "instant" });
          document
            .querySelector("#phase-title")
            ?.focus({ preventScroll: true });
        }
      };
      const mine = next?.turn?.currentId === next?.me?.id;
      const moment = !next
        ? null
        : next.phase === "clues"
          ? mine
            ? "turn-me"
            : "turn-other"
          : ["reveal", "voting", "runoff", "guess", "results"].includes(
                next.phase,
              )
            ? next.phase
            : "phase";
      const withMoment = () => {
        apply();
        play(moment, lastRenderKey);
        cue(next, previousPhase, previousSpeaker);
      };
      if (previousPhase && next && phaseChanged)
        transition(withMoment, "phase");
      else if (
        next?.phase === "clues" &&
        previousSpeaker !== undefined &&
        next.turn?.currentId !== previousSpeaker
      )
        withMoment();
      else {
        const before = state?.voting?.submitted ?? 0;
        apply();
        cue(next, previousPhase, previousSpeaker);
        if ((next?.voting?.submitted ?? 0) > before)
          play("vote-tick", lastRenderKey);
      }
    });
    socket.connect();
  } catch (error) {
    status.textContent = "Not connected";
    app.innerHTML = `<section class="loading"><h1>Couldn’t pull up a chair.</h1><p>${esc(error.message || "Please check your connection.")}</p><a data-reconnect class="button primary" href="${esc(location.pathname + location.search)}">Try again</a></section>`;
  }
}
boot();
