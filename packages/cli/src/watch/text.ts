/**
 * Terminal-cell text helpers for the watch dashboard: display width (wide CJK and emoji take two cells,
 * combining marks none), truncation with "…", padding to an exact width and word wrapping. Inputs are plain
 * text; colors are applied after a cell is fitted, so escape codes never get cut.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}​︀-️]/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const ELLIPSIS = '…';

/** East Asian Wide / Fullwidth ranges (the common blocks). */
const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

export const stripAnsi = (s: string): string => s.replace(ANSI, '');

/** Cells one code point takes: 0, 1 or 2. Control characters count as 0 (they are stripped before display). */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (ZERO_WIDTH.test(ch)) return 0;
  if (cp >= 0x2600 && cp < 0x2800 && !EMOJI.test(ch)) return 1;
  if (WIDE.some(([lo, hi]) => cp >= lo && cp <= hi)) return 2;
  return cp > 0x1f000 && EMOJI.test(ch) ? 2 : 1;
}

/** Display width of a string, ignoring color codes. */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch);
  return w;
}

/** Cuts plain text to at most `width` cells, ending in "…" when anything was cut. */
export function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  if (textWidth(s) <= width) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const w = charWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return out + ELLIPSIS;
}

/** Plain text truncated and space-padded to exactly `width` cells. */
export function fit(s: string, width: number): string {
  const t = truncate(s, width);
  return t + ' '.repeat(Math.max(0, width - textWidth(t)));
}

/** Like fit, but pads on the left. */
export function fitRight(s: string, width: number): string {
  const t = truncate(s, width);
  return ' '.repeat(Math.max(0, width - textWidth(t))) + t;
}

/** Pads an already-fitted (possibly colored) string to `width` cells. */
export function padCells(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - textWidth(s)));
}

/** Splits a word that is wider than `width` into pieces of at most `width` cells. */
function splitWord(word: string, width: number): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const ch of word) {
    if (textWidth(cur) + charWidth(ch) > width && cur !== '') { parts.push(cur); cur = ''; }
    cur += ch;
  }
  return [...parts, cur];
}

/** Word-wraps one paragraph to `width` cells; words wider than a line are split. */
function wrapParagraph(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/ +/).filter((w) => w !== '')) {
    for (const piece of textWidth(word) > width ? splitWord(word, width) : [word]) {
      if (line === '') line = piece;
      else if (textWidth(line) + 1 + textWidth(piece) <= width) line = `${line} ${piece}`;
      else { lines.push(line); line = piece; }
    }
  }
  return [...lines, line];
}

/** Word-wraps multi-line text to `width` cells; blank lines are dropped. Always at least one line. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const paragraphs = text.split('\n').filter((l) => l.trim() !== '');
  const lines = paragraphs.flatMap((p) => wrapParagraph(p, w));
  return lines.length > 0 ? lines : [''];
}
