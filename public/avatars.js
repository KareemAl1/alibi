// Draws a suspect from an avatar object (see shared/avatar.js) in the lineup
// style: a rounded square of color with ink line features. Every part sits on
// the same 64x64 grid so any combination lines up.
import { AVATAR_PARTS, legacyAvatar } from "/shared/avatar.js";

const INK = "#282a2e";

// Eyes for each face, centred around (23, 28) and (41, 28).
const EYES = [
  `<path d="M17 25h12v7H17zM35 25h12v7H35zM29 27h6" fill="${INK}"/>`,
  '<path d="m19 28 4-3 4 3m10 0 4-3 4 3"/>',
  '<path d="m17 24 12 3m7 0 12-3"/><circle cx="24" cy="30" r="2"/><circle cx="40" cy="30" r="2"/>',
  '<path d="M19 29q5 5 10 0m7 0q5 5 10 0"/>',
  '<circle cx="23" cy="28" r="4"/><path d="m37 26 8 4-8 2"/>',
  '<circle cx="23" cy="28" r="7"/><circle cx="42" cy="28" r="7"/><path d="M30 28h5"/>',
  '<path d="M19 28q4-6 8 0"/><circle cx="41" cy="28" r="2"/>',
  '<circle cx="22" cy="28" r="6"/><circle cx="42" cy="28" r="6"/><circle cx="22" cy="28" r="2"/><circle cx="42" cy="28" r="2"/>',
];
// The detective frowns; everyone else smiles.
const MOUTH = (face) =>
  face === 2 ? '<path d="M26 44q6-4 12 0"/>' : '<path d="M26 42q6 7 12 0"/>';

const HATS = [
  "",
  '<path d="M14 18h36M21 17l3-7h17l4 7"/>',
  '<path d="m25 11 5 4 4-6 4 6"/>',
  `<path d="M17 15q1-9 15-10 14 1 15 9-15 4-30 1z" fill="${INK}"/><path d="M32 5V2"/>`,
  `<path d="M24 3h16v11H24z" fill="${INK}"/><path d="M17 15h30"/>`,
  `<path d="M16 16q1-11 16-11t16 11z" fill="${INK}"/><path d="M42 16h12"/>`,
];

const GLASSES = [
  "",
  '<circle cx="23" cy="28" r="7"/><circle cx="41" cy="28" r="7"/><path d="M30 28h4M16 27l-4-2M48 27l4-2"/>',
  '<path d="M14 23h17v10H14zM33 23h17v10H33zM31 27h2"/>',
  '<circle cx="41" cy="28" r="7"/><path d="M48 31q4 7-1 14"/>',
];

const MUSTACHES = [
  "",
  `<path d="M23 39q5-5 9-1 4-4 9 1-5 3-9 0-4 3-9 0z" fill="${INK}"/>`,
  '<path d="M32 38q-4-3-8 0-3 2-5-1M32 38q4-3 8 0 3 2 5-1"/>',
  `<g fill="${INK}" stroke="none" opacity="0.55"><circle cx="22" cy="46" r="1"/><circle cx="26" cy="49" r="1"/><circle cx="31" cy="50" r="1"/><circle cx="36" cy="50" r="1"/><circle cx="41" cy="48" r="1"/><circle cx="44" cy="45" r="1"/><circle cx="28" cy="53" r="1"/><circle cx="34" cy="53" r="1"/></g>`,
];

const clamp = (value, list) =>
  Number.isInteger(value) && value >= 0 && value < list.length ? value : 0;

/** Normalize anything the client might hold (object or legacy number). */
export function lookOf(spec) {
  if (Number.isInteger(spec)) return legacyAvatar(((spec % 8) + 8) % 8);
  const s = spec && typeof spec === "object" ? spec : legacyAvatar(0);
  return {
    color: clamp(s.color, AVATAR_PARTS.color),
    face: clamp(s.face, EYES),
    hat: clamp(s.hat, HATS),
    glasses: clamp(s.glasses, GLASSES),
    mustache: clamp(s.mustache, MUSTACHES),
  };
}

export function avatar(spec, size = "") {
  const a = lookOf(spec);
  const fill = AVATAR_PARTS.color[a.color].value;
  return `<svg class="avatar ${size}" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="22" fill="${fill}"/><g stroke="${INK}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"><g class="eyes">${EYES[a.face]}</g>${MOUTH(a.face)}${MUSTACHES[a.mustache]}${GLASSES[a.glasses]}${HATS[a.hat]}</g></svg>`;
}

/** A short spoken description, e.g. "The detective, teal, fedora, monocle". */
export function describeAvatar(spec) {
  const a = lookOf(spec);
  return [
    AVATAR_PARTS.face[a.face].label,
    AVATAR_PARTS.color[a.color].label.toLowerCase(),
    ...["hat", "glasses", "mustache"]
      .filter((part) => a[part] > 0)
      .map((part) => AVATAR_PARTS[part][a[part]].label.toLowerCase()),
  ].join(", ");
}
