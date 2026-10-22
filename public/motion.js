// Motion for Alibi's big moments. Purely presentational: nothing here reads or
// changes game rules, and every animation only plays transforms and opacity.
//
// - View Transitions keep the header, room bar and phase steps anchored while a
//   phase swaps. Speaking turns skip them: a whole-page snapshot on every turn
//   cost more than it added, so GSAP alone moves the speaker.
// - GSAP plays each moment's entrance on the freshly rendered elements.
// - app.js re-renders the whole page on every state update, so a running moment
//   is rebuilt on the new elements and fast-forwarded to where it was, instead
//   of being cut off.
// - Motion has two modes, set on <html data-motion>: "full", and "reduced",
//   which keeps short fades and color changes but nothing that moves, scales
//   or rotates. Motion is on for everyone by default and does not follow
//   the device's prefers-reduced-motion setting (Kareem's call, October 8).
//   A player turns it down with the header toggle; that choice is
//   remembered on their device.

const lib = () => window.gsap;
const PREF_KEY = "alibi.motion";

export function motionPreference() {
  try {
    const value = localStorage.getItem(PREF_KEY);
    return value === "reduced" ? "reduced" : "full";
  } catch {
    return "full";
  }
}
export const motionMode = motionPreference;
export function setMotionPreference(value) {
  try {
    localStorage.setItem(PREF_KEY, value === "reduced" ? "reduced" : "full");
  } catch {}
  applyMotionMode();
}
function applyMotionMode() {
  document.documentElement.dataset.motion = motionMode();
}
applyMotionMode();

export const motionAllowed = () => motionMode() === "full" && Boolean(lib());
const gentleAllowed = () => motionMode() === "reduced" && Boolean(lib());

// Reduced mode: a short fade on what changed, no movement.
const gentle = {
  phase:
    "#phase-title, .stage > p, .results-heading, .result-card, .result-next",
  card: ".private-card .role-content",
  results: ".results-heading, .result-card, .result-next, .ballot-details",
};

let active = null; // { key, build, startedAt, duration, timeline }
// Elapsed time is measured on GSAP's own clock so a rebuilt moment resumes
// exactly where the interrupted one was.
const clock = () => lib().globalTimeline.time();

if (lib()) lib().config({ nullTargetWarn: false });

/**
 * Run a DOM update inside a view transition when motion is allowed.
 * kind names the transition for CSS (html[data-vt]); only "phase" is used.
 */
export function transition(update, kind = "phase") {
  if (!motionAllowed() || !document.startViewTransition || document.hidden) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.vt = kind;
  try {
    const vt = document.startViewTransition(update);
    vt.finished.finally(() => {
      if (root.dataset.vt === kind) delete root.dataset.vt;
    });
  } catch {
    delete root.dataset.vt;
    update();
  }
}

/** Start a named moment for the current render key. */
export function play(name, key) {
  if (gentleAllowed()) {
    const targets =
      name === "card"
        ? gentle.card
        : name === "results"
          ? gentle.results
          : [
                "select",
                "vote-tick",
                "turn-other",
                "turn-me",
                "pick",
                "randomize",
              ].includes(name)
            ? null
            : gentle.phase;
    if (targets)
      lib().from(targets, {
        opacity: 0,
        duration: 0.2,
        ease: "none",
        clearProps: "opacity",
      });
    return;
  }
  if (!motionAllowed()) return;
  const build = moments[name];
  if (!build) return;
  active?.timeline?.kill();
  const timeline = build(lib());
  if (!timeline) return;
  active = {
    key,
    build,
    startedAt: clock(),
    duration: timeline.duration(),
    timeline,
  };
  // Exposed for the motion checks in design/motion-perf.mjs.
  document.documentElement.dataset.moment = `${name}:${active.duration.toFixed(2)}`;
}

/** Called after every render: rebuild a moment the render interrupted. */
export function afterRender(key) {
  if (!active) return;
  if (!lib()) return;
  const elapsed = clock() - active.startedAt;
  if (active.key !== key || elapsed >= active.duration || !motionAllowed()) {
    active.timeline?.kill();
    active = null;
    return;
  }
  active.timeline.kill();
  active.timeline = active.build(lib());
  if (active.timeline) active.timeline.time(elapsed);
  else active = null;
}

// Wrap each character of an element's text for a stagger, keeping the
// accessible name on the element itself.
function letters(el) {
  if (!el) return [];
  if (!el.dataset.split) {
    const text = el.textContent;
    el.dataset.split = "1";
    el.setAttribute("aria-label", text);
    el.textContent = "";
    // Letters are grouped per word so a word never wraps mid-way.
    text.split(/(\s+)/).forEach((part) => {
      if (!part) return;
      if (/^\s+$/.test(part)) {
        el.append(document.createTextNode(" "));
        return;
      }
      const word = document.createElement("span");
      word.className = "motion-word";
      word.setAttribute("aria-hidden", "true");
      for (const ch of part) {
        const span = document.createElement("span");
        span.className = "motion-ch";
        span.textContent = ch;
        word.append(span);
      }
      el.append(word);
    });
  }
  return [...el.querySelectorAll(".motion-ch")];
}

// Stagger that never spreads further than `max` seconds in total, so a full
// ten-player room takes as long as a four-player one.
const spread = (each, max) => (i, _el, list) =>
  i * Math.min(each, max / Math.max(1, list.length - 1));

// Every tween hands its element back to the stylesheet when it finishes, so a
// dimmed or disabled control never keeps an inline opacity from an entrance.
const clean = { defaults: { clearProps: "opacity,transform" } };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// Shared entrance for a new phase: heading, then the supporting content.
function phaseIn(g, tl, at = 0) {
  const stage = $(".stage, .room-heading, .results-heading");
  tl.from(
    "#phase-title",
    { y: 26, opacity: 0, duration: 0.42, ease: "power3.out" },
    at,
  );
  if (stage)
    tl.from(
      [...stage.children].filter(
        (el) => el.id !== "phase-title" && !el.classList.contains("eyebrow"),
      ),
      {
        y: 14,
        opacity: 0,
        duration: 0.26,
        stagger: spread(0.04, 0.14),
        ease: "power2.out",
      },
      at + 0.1,
    );
  return tl;
}

const moments = {
  // Any phase without a bigger moment of its own.
  phase(g) {
    return phaseIn(g, g.timeline(clean));
  },

  // Cards dealt: the stage settles and the private card slides in face down.
  reveal(g) {
    const tl = phaseIn(g, g.timeline(clean));
    tl.from(
      ".private-card",
      { y: 30, rotation: -2, opacity: 0, duration: 0.42, ease: "power3.out" },
      0.08,
    );
    return tl;
  },

  // Turning your card over: a quick flip, then the word types onto the card.
  card(g) {
    const card = $(".private-card");
    const content = $(".private-card .role-content");
    if (!card || !content) return null;
    const tl = g.timeline(clean);
    tl.fromTo(
      card,
      { rotationY: -80, transformPerspective: 900, transformOrigin: "50% 50%" },
      { rotationY: 0, duration: 0.42, ease: "back.out(1.3)" },
    );
    tl.from(
      content.querySelector(".role-label"),
      { y: 8, opacity: 0, duration: 0.25, ease: "power2.out" },
      0.12,
    );
    tl.from(
      letters(content.querySelector("h2")),
      {
        y: 14,
        opacity: 0,
        duration: 0.22,
        stagger: spread(0.025, 0.2),
        ease: "power2.out",
      },
      0.18,
    );
    tl.from(
      content.querySelectorAll("p"),
      { opacity: 0, duration: 0.25, stagger: 0.05 },
      0.3,
    );
    return tl;
  },

  // Your clue turn: you step under the lamp.
  "turn-me"(g) {
    const tl = g.timeline(clean);
    tl.from(
      ".turn-row.current",
      { x: -10, opacity: 0.4, duration: 0.3, ease: "power2.out" },
      0,
    );
    tl.from(
      ".speaker-avatar",
      {
        y: -46,
        rotation: -18,
        scale: 0.7,
        duration: 0.5,
        ease: "back.out(1.8)",
      },
      0,
    );
    tl.from(".speaking-label", { y: 10, opacity: 0, duration: 0.25 }, 0.15);
    tl.fromTo(
      "#phase-title",
      { scale: 1.18, opacity: 0 },
      { scale: 1, opacity: 1, duration: 0.38, ease: "power3.out" },
      0.18,
    );
    tl.from(
      '.stage [data-action="done"], .action-dock [data-action="done"]',
      { y: 12, opacity: 0, duration: 0.25, ease: "power2.out" },
      0.3,
    );
    return tl;
  },

  // Someone else's turn: the new speaker slides under the lamp.
  "turn-other"(g) {
    const tl = g.timeline(clean);
    tl.from(
      ".turn-row.current",
      { x: -10, opacity: 0.4, duration: 0.3, ease: "power2.out" },
      0,
    );
    tl.from(
      ".speaker-avatar",
      { x: 34, rotation: 10, opacity: 0, duration: 0.34, ease: "power3.out" },
      0,
    );
    tl.from(
      "#phase-title",
      { y: 12, opacity: 0, duration: 0.3, ease: "power2.out" },
      0.06,
    );
    return tl;
  },

  // Building your suspect: the preview reacts to each pick.
  pick(g) {
    return g
      .timeline(clean)
      .fromTo(
        ".builder-preview .avatar",
        { scaleX: 1.12, scaleY: 0.88 },
        { scaleX: 1, scaleY: 1, duration: 0.3, ease: "elastic.out(1, 0.45)" },
      );
  },
  // Randomize: the suspect spins around to show their new look.
  randomize(g) {
    return g
      .timeline(clean)
      .fromTo(
        ".builder-preview .avatar",
        { rotationY: -180, transformPerspective: 500, scale: 0.85 },
        { rotationY: 0, scale: 1, duration: 0.45, ease: "back.out(1.6)" },
      )
      .from(
        ".builder-option.selected",
        { scale: 0.8, duration: 0.25, stagger: 0.03, ease: "back.out(2)" },
        0.05,
      );
  },

  // Voting opens: the suspects step into the lineup one by one.
  voting(g) {
    const tl = phaseIn(g, g.timeline(clean));
    tl.from(
      ".vote-candidate",
      {
        y: 22,
        opacity: 0,
        duration: 0.26,
        stagger: spread(0.04, 0.16),
        ease: "power2.out",
      },
      0.08,
    );
    return tl;
  },

  // Picking a suspect: their placard flips to orange.
  select(g) {
    const plate = $(".vote-candidate.selected b");
    if (!plate) return null;
    return g
      .timeline()
      .fromTo(
        plate,
        { scaleY: 0.2, transformOrigin: "50% 0%" },
        { scaleY: 1, duration: 0.22, ease: "back.out(2)" },
      )
      .from(
        ".vote-candidate.selected .avatar",
        { y: -8, duration: 0.24, ease: "power2.out" },
        0,
      );
  },

  // Someone else locked a vote: the participation count ticks over.
  "vote-tick"(g) {
    return g
      .timeline(clean)
      .fromTo(
        ".vote-progress b",
        { scale: 1.35, color: "#ff6a2b" },
        { scale: 1, color: "", duration: 0.32, ease: "back.out(2)" },
      );
  },

  // The ballot closes and the group caught someone: the accusation lands.
  guess(g) {
    const tl = g.timeline(clean);
    tl.from(
      ".stage-icon",
      { scale: 0, rotation: -30, duration: 0.5, ease: "back.out(2.2)" },
      0,
    );
    tl.from(
      "#phase-title",
      { y: 30, opacity: 0, duration: 0.42, ease: "power3.out" },
      0.12,
    );
    const accused = $(".stage p b");
    if (accused)
      tl.from(
        letters(accused),
        {
          y: -18,
          opacity: 0,
          duration: 0.24,
          stagger: spread(0.035, 0.25),
          ease: "power2.out",
        },
        0.42,
      );
    tl.from(
      ".stage p, .stage .deadline, .guess-form, .waiting-label",
      { opacity: 0, y: 10, duration: 0.3, stagger: 0.06 },
      0.5,
    );
    tl.from(".ballot-details", { opacity: 0, y: 16, duration: 0.3 }, 0.8);
    return tl;
  },

  // A tied ballot: the lineup shakes and resets for the runoff.
  runoff(g) {
    const tl = phaseIn(g, g.timeline(clean));
    tl.from(
      ".vote-candidate",
      {
        y: 18,
        opacity: 0,
        duration: 0.3,
        stagger: spread(0.04, 0.16),
        ease: "power2.out",
      },
      0.15,
    );
    tl.fromTo(
      "#phase-title",
      { x: -6 },
      { x: 0, duration: 0.4, ease: "elastic.out(1.2, 0.3)" },
      0.42,
    );
    return tl;
  },

  // Results, the biggest reveal: verdict, the word, the imposter, the stamp,
  // then the ballot reads out vote by vote. About two seconds end to end.
  results(g) {
    const tl = g.timeline(clean);
    tl.from(
      ".results-heading > *",
      { y: 22, opacity: 0, duration: 0.4, stagger: 0.06, ease: "power3.out" },
      0,
    );
    // The card arrives once the previous screen has faded (0.2s).
    tl.from(
      ".result-card",
      { y: 48, rotation: 1.5, opacity: 0, duration: 0.42, ease: "power3.out" },
      0.22,
    );
    tl.from(".result-card > .eyebrow", { opacity: 0, duration: 0.2 }, 0.42);
    tl.from(
      letters($(".result-card h2")),
      {
        y: 20,
        opacity: 0,
        duration: 0.24,
        stagger: spread(0.04, 0.3),
        ease: "power2.out",
      },
      0.48,
    );
    // The imposter turns around.
    tl.fromTo(
      ".reveal-imposter .avatar",
      { rotationY: 180, transformPerspective: 600, scale: 0.8, opacity: 0 },
      {
        rotationY: 0,
        scale: 1,
        opacity: 1,
        duration: 0.5,
        ease: "back.out(1.5)",
      },
      0.85,
    );
    tl.from(
      ".reveal-imposter > div",
      { x: -14, opacity: 0, duration: 0.3, ease: "power2.out" },
      1,
    );
    tl.from(
      ".result-reason, .final-guess",
      { opacity: 0, duration: 0.3, stagger: 0.06 },
      1.1,
    );
    // The stamp comes down hard and the card takes the hit.
    tl.from(
      ".result-card > .tiny-stamp",
      {
        scale: 2.8,
        rotation: -32,
        opacity: 0,
        duration: 0.24,
        ease: "power4.in",
      },
      1.25,
    );
    tl.to(
      ".result-card",
      { y: 4, duration: 0.06, yoyo: true, repeat: 1, ease: "power1.out" },
      1.49,
    );
    tl.from(
      ".result-next > *",
      { y: 14, opacity: 0, duration: 0.3, stagger: 0.05, ease: "power2.out" },
      1.4,
    );
    // The deciding ballot reads out and each named suspect flinches as their
    // tally mark lands in the lineup.
    const finalRows = [
      ...document.querySelectorAll(".ballot-details .ballot:last-child > div"),
    ];
    const each = Math.min(0.07, 0.45 / Math.max(1, finalRows.length - 1));
    const seen = new Map();
    finalRows.forEach((row, i) => {
      const id = row.dataset.target;
      const tile =
        id &&
        document.querySelector(`.player-tile[data-player="${CSS.escape(id)}"]`);
      if (!tile) return;
      const n = seen.get(id) || 0;
      seen.set(id, n + 1);
      const at = 1.7 + i * each + 0.1;
      const mark = tile.querySelectorAll(".tally i")[n];
      if (mark)
        tl.from(
          mark,
          { scaleY: 0, opacity: 0, duration: 0.16, ease: "back.out(3)" },
          at,
        );
      tl.fromTo(
        tile.querySelector(".avatar"),
        { y: 0, rotation: 0 },
        {
          keyframes: [
            { y: -7, rotation: n % 2 ? 5 : -5, duration: 0.09 },
            { y: 0, rotation: 0, duration: 0.18, ease: "power2.out" },
          ],
        },
        at,
      );
    });
    tl.from(
      ".ballot-details .ballot > div",
      {
        x: -16,
        opacity: 0,
        duration: 0.22,
        stagger: spread(0.07, 0.45),
        ease: "power2.out",
      },
      1.6,
    );
    return tl;
  },
};

export const motionMoments = Object.keys(moments);
