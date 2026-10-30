/**
 * Path data for the UI icon set: 24×24 viewBox, drawn as strokes (the `Icon`
 * component sets stroke 1.75, round caps and joins, no fill). One string per
 * icon; a string may hold several subpaths.
 */

/** a full circle as path data (two arcs), so every icon stays a single `d` */
function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

export const ICONS = {
  menu: "M4 6h16M4 12h16M4 18h16",
  mission: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  inbox:
    "M3 13h5l1.5 2.5h5L16 13h5M3 13l2.5-7.5A1.5 1.5 0 0 1 6.9 4.5h10.2a1.5 1.5 0 0 1 1.4 1L21 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z",
  pullRequest: `${circle(6, 6, 2.5)}${circle(6, 18, 2.5)}${circle(18, 18, 2.5)}M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4M13 3.5 10.5 6 13 8.5`,
  usage: "M4 20h16M7 16v-5M12 16V6M17 16V9",
  experts: `${circle(9, 8, 3.5)}M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6`,
  settings: `M4 7h9M17 7h3M4 17h3M11 17h9${circle(15, 7, 2)}${circle(9, 17, 2)}`,
  search: `${circle(11, 11, 6.5)}M20 20l-4.4-4.4`,
  plus: "M12 5v14M5 12h14",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  close: "M6 6l12 12M18 6 6 18",
  more: `${circle(5, 12, 1)}${circle(12, 12, 1)}${circle(19, 12, 1)}`,
  pin: "M9 3h6M10 3v6l-3.5 4v2h11v-2L14 9V3M12 15v6",
  snooze: `${circle(12, 12, 8.5)}M12 7.5V12l3 2`,
  archive: "M3.5 4.5h17v4h-17zM5 8.5v10A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-10M10 12.5h4",
  merge: `${circle(6, 5, 2.5)}${circle(6, 19, 2.5)}${circle(18, 12, 2.5)}M6 7.5v9M6 7.5a4.5 4.5 0 0 0 4.5 4.5h5`,
  branch: `${circle(6, 18, 2.5)}${circle(18, 6, 2.5)}M6 3.5v12M18 8.5a7 7 0 0 1-7 7H8.5`,
  bell: "M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0",
  terminal: "M4 6.5l5 5-5 5M12 18h8",
  folder:
    "M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z",
  file: "M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5zM14 3v4.5h4.5",
  environment: "M4 4.5h16v6H4zM4 13.5h16v6H4zM7.5 7.5h.01M7.5 16.5h.01",
  play: "M7 4.5v15l12-7.5z",
  stop: "M6 6h12v12H6z",
  refresh: "M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4",
  copy: "M9 9h10.5v10.5H9zM15 9V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15H9",
  external: "M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10",
  edit: "M15.5 4.5l4 4L9 19H5v-4zM13 7l4 4",
  trash: "M4 7h16M9.5 7V4.5h5V7M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M10 11v6M14 11v6",
  filter: "M4 5h16l-6.5 7.5V19l-3 1.5v-8z",
  sun: `${circle(12, 12, 4)}M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4`,
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  keyboard: "M3 6h18v12H3zM7 9.5h.01M10.5 9.5h.01M14 9.5h.01M17.5 9.5h.01M7 12.5h.01M17.5 12.5h.01M8.5 15h7",
  image: `M4 5.5h16v13H4z${circle(9, 10, 1.5)}M4 16l5-4.5 4 3.5 3-2.5 4 3.5`,
  chat: "M4 5.5h16v10.5H10l-4.5 3.5V16H4z",
  question: `${circle(12, 12, 8.5)}M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.7-2.5 2-2.5 4M12 16.5h.01`,
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  chevronLeft: "M15 6l-6 6 6 6",
  info: `${circle(12, 12, 8.5)}M12 11v5.5M12 7.5h.01`,
  zap: "M13 3 5 13.5h6L10 21l8-10.5h-6z",
  clock: `${circle(12, 12, 8.5)}M12 7.5V12h4`,
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  warning: "M12 4 2.5 20h19zM12 10v4.5M12 17.5h.01",
  sidebar: "M4 5h16v14H4zM9.5 5v14",
} as const satisfies Record<string, string>;

export type IconName = keyof typeof ICONS;
