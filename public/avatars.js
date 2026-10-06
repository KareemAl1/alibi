export const AVATARS = [
  "The cool one",
  "The optimist",
  "The detective",
  "The dreamer",
  "The wildcard",
  "The professor",
  "The charmer",
  "The night owl",
];
export function avatar(index = 0, size = "") {
  const i = Number(index) % 8;
  const colors = [
    "#ed956e",
    "#c6c596",
    "#d3b6d8",
    "#8fbabd",
    "#e4c16b",
    "#b6c5db",
    "#deacae",
    "#a5b68f",
  ];
  const eyes = [
    '<path d="M17 25h12v7H17zM35 25h12v7H35zM29 27h6" fill="#24262b"/>',
    '<path d="m19 28 4-3 4 3m10 0 4-3 4 3"/>',
    '<path d="m17 24 12 3m7 0 12-3"/><circle cx="24" cy="30" r="2"/><circle cx="40" cy="30" r="2"/>',
    '<path d="M19 29q5 5 10 0m7 0q5 5 10 0"/>',
    '<circle cx="23" cy="28" r="4"/><path d="m37 26 8 4-8 2"/>',
    '<circle cx="23" cy="28" r="7"/><circle cx="42" cy="28" r="7"/><path d="M30 28h5"/>',
    '<path d="M19 28q4-6 8 0"/><circle cx="41" cy="28" r="2"/>',
    '<circle cx="22" cy="28" r="6"/><circle cx="42" cy="28" r="6"/><circle cx="22" cy="28" r="2"/><circle cx="42" cy="28" r="2"/>',
  ];
  return `<svg class="avatar ${size}" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="22" fill="${colors[i]}"/><g stroke="#282a2e" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"><g class="eyes">${eyes[i]}</g><path d="M26 42q6 ${i === 2 ? "-4" : "7"} 12 0"/>${i === 2 ? '<path d="M14 18h36M21 17l3-7h17l4 7"/>' : i === 4 ? '<path d="m25 11 5 4 4-6 4 6"/>' : ""}</g></svg>`;
}
