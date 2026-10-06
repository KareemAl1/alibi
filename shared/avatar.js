// Avatar options shared by the server (validation) and every client (the
// builder and rendering). An avatar is a small object of option indexes, e.g.
// { color: 3, face: 1, hat: 2, glasses: 0, mustache: 1 }. Clients never send
// SVG or colors, only indexes, and the server accepts nothing else.

export const AVATAR_PARTS = {
  color: [
    { id: "clay", label: "Clay", value: "#ed956e" },
    { id: "olive", label: "Olive", value: "#c6c596" },
    { id: "lilac", label: "Lilac", value: "#d3b6d8" },
    { id: "teal", label: "Teal", value: "#8fbabd" },
    { id: "mustard", label: "Mustard", value: "#e4c16b" },
    { id: "denim", label: "Denim", value: "#b6c5db" },
    { id: "rose", label: "Rose", value: "#deacae" },
    { id: "sage", label: "Sage", value: "#a5b68f" },
    { id: "sand", label: "Sand", value: "#d9c39b" },
    { id: "brick", label: "Brick", value: "#cf8a7a" },
  ],
  face: [
    { id: "cool", label: "The cool one" },
    { id: "optimist", label: "The optimist" },
    { id: "detective", label: "The detective" },
    { id: "dreamer", label: "The dreamer" },
    { id: "wildcard", label: "The wildcard" },
    { id: "professor", label: "The professor" },
    { id: "charmer", label: "The charmer" },
    { id: "owl", label: "The night owl" },
  ],
  hat: [
    { id: "none", label: "No hat" },
    { id: "fedora", label: "Fedora" },
    { id: "tuft", label: "Cowlick" },
    { id: "beret", label: "Beret" },
    { id: "tophat", label: "Top hat" },
    { id: "cap", label: "Cap" },
  ],
  glasses: [
    { id: "none", label: "No glasses" },
    { id: "round", label: "Round glasses" },
    { id: "square", label: "Square glasses" },
    { id: "monocle", label: "Monocle" },
  ],
  mustache: [
    { id: "none", label: "No mustache" },
    { id: "classic", label: "Classic mustache" },
    { id: "handlebar", label: "Handlebar mustache" },
    { id: "stubble", label: "Stubble" },
  ],
};
export const AVATAR_PART_NAMES = Object.keys(AVATAR_PARTS);

// The eight original suspects, so a stored or sent index 0 to 7 keeps the
// exact look it had before the builder.
export function legacyAvatar(index) {
  return {
    color: index,
    face: index,
    hat: index === 2 ? 1 : index === 4 ? 2 : 0,
    glasses: 0,
    mustache: 0,
  };
}

/**
 * Returns a clean avatar object, or null if the input is not a valid choice.
 * Accepts the legacy integers 0 to 7. Unknown keys and out-of-range or
 * non-integer values are rejected rather than repaired.
 */
export function normalizeAvatar(input) {
  if (Number.isInteger(input) && input >= 0 && input <= 7)
    return legacyAvatar(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== AVATAR_PART_NAMES.length) return null;
  const clean = {};
  for (const part of AVATAR_PART_NAMES) {
    const value = input[part];
    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value >= AVATAR_PARTS[part].length
    )
      return null;
    clean[part] = value;
  }
  return clean;
}

/** A random valid avatar. Extras (hat, glasses, mustache) are sometimes off. */
export function randomAvatar(random = Math.random) {
  const pick = (part, chanceOfNone = 0) =>
    random() < chanceOfNone
      ? 0
      : Math.floor(random() * AVATAR_PARTS[part].length);
  return {
    color: pick("color"),
    face: pick("face"),
    hat: pick("hat", 0.3),
    glasses: pick("glasses", 0.55),
    mustache: pick("mustache", 0.55),
  };
}
