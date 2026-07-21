import type { OrderedListStyle } from '../src/protocol';

export type SourceRange = { from: number; to: number };
export type InlineCodeRange = SourceRange & { markerLength: number };

export type FencedCodeRange = {
  from: number;
  to: number;
  openFrom: number;
  openTo: number;
  closeFrom?: number;
  closeTo?: number;
  contentStartLine: number;
  contentEndLine: number;
  language: string;
  languageFrom: number;
  languageTo: number;
  code: string;
};

export function containsPosition(ranges: SourceRange[], position: number): boolean {
  return ranges.some((range) => position >= range.from && position < range.to);
}

// A character is escaped when preceded by an odd number of backslashes: `\*` escapes the
// star, but `\\*` is an escaped backslash followed by an unescaped, live star.
export function isEscaped(source: string, position: number): boolean {
  let backslashes = 0;
  let index = position - 1;
  while (index >= 0 && source[index] === '\\') {
    backslashes++;
    index--;
  }
  return backslashes % 2 === 1;
}

export function codeRanges(source: string): SourceRange[] {
  const ranges = fencedCodeRanges(source);
  for (const range of inlineCodeRanges(source, ranges)) ranges.push(range);
  return ranges;
}

export function fencedCodeRanges(source: string): SourceRange[] {
  return detailedFencedCodeRanges(source).map(({ from, to }) => ({ from, to }));
}

export function detailedFencedCodeRanges(source: string): FencedCodeRange[] {
  const lines = source.split('\n');
  const ranges: FencedCodeRange[] = [];
  let offset = 0;
  let open: { marker: string; length: number; from: number; to: number; line: number; language: string; languageFrom: number; languageTo: number } | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    const lineFrom = offset;
    const lineTo = offset + line.length;
    if (match) {
      const marker = match[1][0];
      if (!open) {
        const language = match[2].trim().split(/\s+/)[0] ?? '';
        const languageStart = line.indexOf(language, match[1].length);
        open = {
          marker,
          length: match[1].length,
          from: lineFrom,
          to: lineTo,
          line: index + 1,
          language,
          languageFrom: language ? lineFrom + languageStart : lineFrom + match[1].length,
          languageTo: language ? lineFrom + languageStart + language.length : lineFrom + match[1].length,
        };
      } else if (marker === open.marker && match[1].length >= open.length && !match[2].trim()) {
        ranges.push({
          from: open.from,
          to: lineTo,
          openFrom: open.from,
          openTo: open.to,
          closeFrom: lineFrom,
          closeTo: lineTo,
          contentStartLine: open.line + 1,
          contentEndLine: index,
          language: open.language,
          languageFrom: open.languageFrom,
          languageTo: open.languageTo,
          code: lines.slice(open.line, index).join('\n'),
        });
        open = undefined;
      }
    }
    offset = lineTo + 1;
  }
  if (open) {
    ranges.push({
      from: open.from,
      to: source.length,
      openFrom: open.from,
      openTo: open.to,
      contentStartLine: open.line + 1,
      contentEndLine: lines.length,
      language: open.language,
      languageFrom: open.languageFrom,
      languageTo: open.languageTo,
      code: lines.slice(open.line).join('\n'),
    });
  }
  return ranges.filter((range) => range.contentStartLine <= range.contentEndLine);
}

export type ImageRange = { from: number; to: number; alt: string; src: string; ownLine: boolean };

// The destination is either a CommonMark `<...>` wrapped form (allows spaces, no `)`
// ambiguity) or a bare token that stops at unescaped whitespace or a closing paren.
const imagePattern = /!\[([^\]\n]*)\]\((?:<([^<>\n]*)>|([^\s)]+))(?:\s+["'][^"'\n]*["'])?\)/g;

export function imageRanges(source: string): ImageRange[] {
  const excluded = codeRanges(source);
  const results: ImageRange[] = [];
  for (const match of source.matchAll(imagePattern)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (containsPosition(excluded, from) || isEscaped(source, from)) continue;
    const lineStart = source.lastIndexOf('\n', from - 1) + 1;
    const lineBreak = source.indexOf('\n', to);
    const lineEnd = lineBreak < 0 ? source.length : lineBreak;
    results.push({
      from,
      to,
      alt: match[1],
      src: match[2] ?? match[3],
      ownLine: source.slice(lineStart, lineEnd).trim() === match[0],
    });
  }
  return results;
}

// Destination ranges for `[label](dest)` and `![alt](dest)`, covering only the
// parenthesized `dest` part (including a `<...>` wrapper when present), not the label.
// Other scanners (emphasis, etc.) exclude these so a filename like `a_b_c.png` inside a
// destination is never mistaken for Markdown syntax.
const linkOrImagePattern = /!?\[[^\]\n]*\]\((?:<[^<>\n]*>|[^\s)]+)(?:\s+["'][^"'\n]*["'])?\)/g;

export function linkDestinationRanges(source: string): SourceRange[] {
  const excluded = fencedCodeRanges(source);
  const ranges: SourceRange[] = [];
  for (const match of source.matchAll(linkOrImagePattern)) {
    const from = match.index ?? 0;
    if (containsPosition(excluded, from)) continue;
    const openParen = match[0].indexOf('](');
    const destFrom = from + openParen + 2;
    const destTo = from + match[0].length - 1;
    ranges.push({ from: destFrom, to: destTo });
  }
  return ranges;
}

// CommonMark's escapable ASCII punctuation, as character-class ranges: !"#$%&'()*+,-./
// then :;<=>? then @ then [\]^_` then {|}~. A leading backslash before any of these hides
// the backslash and leaves the character as plain text instead of live Markdown syntax.
// Matching left to right naturally reproduces the odd/even backslash-run pairing rule:
// each match consumes two characters, so `\\\*` pairs as `\\` (escaped backslash) then
// `\*` (escaped star), while `\\*` pairs as `\\` alone, leaving the star live.
const escapableCharPattern = /\\[!-/:-@[-`{-~]/g;

export function escapedCharRanges(source: string): SourceRange[] {
  const excluded = codeRanges(source);
  const results: SourceRange[] = [];
  for (const match of source.matchAll(escapableCharPattern)) {
    const from = match.index ?? 0;
    if (containsPosition(excluded, from)) continue;
    results.push({ from, to: from + 2 });
  }
  return results;
}

export type TagRange = { from: number; to: number; name: string };

// Requires a letter/underscore right after `#` (excludes issue references like `#123`) and
// forbids a word character or another `#` immediately before it (excludes `foo#bar`, `##`
// heading markers, and C#). A heading's `#` is always followed by whitespace, which this
// pattern never allows, so the two never overlap.
const tagPattern = /(?<![\w#])#([A-Za-z_][\w/-]*)/g;

export function tagRanges(source: string): TagRange[] {
  const excluded = [...codeRanges(source), ...linkDestinationRanges(source)];
  const results: TagRange[] = [];
  for (const match of source.matchAll(tagPattern)) {
    const from = match.index ?? 0;
    if (containsPosition(excluded, from) || isEscaped(source, from)) continue;
    results.push({ from, to: from + match[0].length, name: match[1] });
  }
  return results;
}

export type TableCell = { text: string; from: number; to: number };
export type TableAlignment = 'left' | 'center' | 'right' | null;
export type TableRange = {
  from: number;
  to: number;
  alignments: TableAlignment[];
  header: TableCell[];
  rows: TableCell[][];
};

export function tableRanges(source: string): TableRange[] {
  const lines = source.split('\n');
  const excluded = fencedCodeRanges(source);
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const results: TableRange[] = [];
  let index = 0;
  while (index < lines.length - 1) {
    if (!lines[index].includes('|')
      || containsPosition(excluded, offsets[index])
      || !isDelimiterRow(lines[index + 1])) {
      index++;
      continue;
    }
    const header = splitTableRow(lines[index], offsets[index]);
    const delimiterCells = splitTableRow(lines[index + 1], offsets[index + 1]);
    if (header.length === 0 || delimiterCells.length !== header.length) {
      index++;
      continue;
    }
    const alignments = delimiterCells.map((cell) => alignmentOf(cell.text));
    const rows: TableCell[][] = [];
    let end = index + 1;
    while (end + 1 < lines.length && lines[end + 1].includes('|') && !isDelimiterRow(lines[end + 1])) {
      end++;
      rows.push(splitTableRow(lines[end], offsets[end]));
    }
    results.push({ from: offsets[index], to: offsets[end] + lines[end].length, alignments, header, rows });
    index = end + 1;
  }
  return results;
}

function isDelimiterRow(line: string): boolean {
  return line.includes('-') && /^ {0,3}\|?(?:\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/.test(line);
}

function alignmentOf(text: string): TableAlignment {
  const left = text.startsWith(':');
  const right = text.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function splitTableRow(line: string, lineOffset: number): TableCell[] {
  let start = 0;
  let end = line.length;
  while (start < end && line[start] === ' ') start++;
  while (end > start && line[end - 1] === ' ') end--;
  if (line[start] === '|') start++;
  if (end > start && line[end - 1] === '|' && line[end - 2] !== '\\') end--;
  const cells: TableCell[] = [];
  let cellStart = start;
  for (let position = start; position <= end; position++) {
    if (position < end && line[position] === '\\') {
      position++;
      continue;
    }
    if (position === end || line[position] === '|') {
      let from = cellStart;
      let to = position;
      while (from < to && line[from] === ' ') from++;
      while (to > from && line[to - 1] === ' ') to--;
      cells.push({
        text: line.slice(from, to).replace(/\\\|/g, '|'),
        from: lineOffset + from,
        to: lineOffset + to,
      });
      cellStart = position + 1;
    }
  }
  return cells;
}

export type ListItemRange = {
  lineFrom: number;
  lineTo: number;
  markerFrom: number;
  markerTo: number;
  level: number;
  ordered: boolean;
  task?: { checked: boolean; boxFrom: number; boxTo: number };
};

const listItemPattern = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(?:(\[([ xX])\])(?=[ \t]))?/;
const horizontalRulePattern = /^ {0,3}(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/;

export function listItemRanges(source: string): ListItemRange[] {
  const excluded = fencedCodeRanges(source);
  const lines = source.split('\n');
  const results: ListItemRange[] = [];
  let offset = 0;
  for (const line of lines) {
    const match = line.match(listItemPattern);
    if (match && !horizontalRulePattern.test(line) && !containsPosition(excluded, offset)) {
      const indent = match[1].replace(/\t/g, '  ').length;
      const ordered = match[3] !== undefined;
      const markerFrom = offset + match[1].length;
      const markerTo = markerFrom + (ordered ? match[3].length + 1 : 1);
      const item: ListItemRange = {
        lineFrom: offset,
        lineTo: offset + line.length,
        markerFrom,
        markerTo,
        level: Math.min(Math.floor(indent / 2), 5),
        ordered,
      };
      if (match[7] !== undefined) {
        const boxFrom = markerTo + match[5].length;
        item.task = { checked: match[7].toLowerCase() === 'x', boxFrom, boxTo: boxFrom + 3 };
      }
      results.push(item);
    }
    offset += line.length + 1;
  }
  return results;
}

const ROMAN_VALUES: ReadonlyArray<readonly [number, string]> = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
  [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
  [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

function toRomanNumeral(value: number): string {
  let remaining = value;
  let result = '';
  for (const [amount, symbol] of ROMAN_VALUES) {
    while (remaining >= amount) {
      result += symbol;
      remaining -= amount;
    }
  }
  return result;
}

// Base-26 "spreadsheet column" letters: a, b, ..., z, aa, ab, ...
function toLetters(value: number): string {
  let remaining = value;
  let result = '';
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    result = String.fromCharCode(97 + remainder) + result;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return result;
}

function cycleNumeral(value: number, level: number): string {
  const scheme = level % 3;
  if (scheme === 0) return String(value);
  if (scheme === 1) return toLetters(value);
  return toRomanNumeral(value);
}

// True when the source between two consecutive list items contains a real, non-list line
// (a paragraph, a heading, ...) rather than only blank lines — a genuine CommonMark list
// break, after which numbering restarts rather than continuing.
function isListInterrupted(source: string, from: number, to: number): boolean {
  return source.slice(from, to).split('\n').some((line) => line.trim().length > 0);
}

// Computes a display label for each ordered item, keyed by its markerFrom offset. Mirrors
// how nested <ol> numbering works in HTML: a counter per nesting level, reset whenever a
// shallower item is seen, the list is interrupted by non-list content, or the item type at
// that level switches between ordered and unordered.
export function orderedListLabels(
  source: string,
  items: ListItemRange[],
  style: OrderedListStyle,
): Map<number, string> {
  const labels = new Map<number, string>();
  const counters: number[] = [];
  const lastOrderedAtLevel: boolean[] = [];
  let previous: ListItemRange | undefined;
  for (const item of items) {
    if (previous && isListInterrupted(source, previous.lineTo, item.lineFrom)) {
      counters.length = 0;
      lastOrderedAtLevel.length = 0;
    }
    previous = item;
    if (lastOrderedAtLevel[item.level] !== undefined && lastOrderedAtLevel[item.level] !== item.ordered) {
      counters[item.level] = 0;
    }
    counters.length = item.level + 1;
    lastOrderedAtLevel.length = item.level + 1;
    lastOrderedAtLevel[item.level] = item.ordered;
    if (!item.ordered) continue;
    counters[item.level] = (counters[item.level] ?? 0) + 1;
    const label = style === 'decimal'
      ? counters.slice(0, item.level + 1).join('.')
      : cycleNumeral(counters[item.level], item.level);
    labels.set(item.markerFrom, label);
  }
  return labels;
}

export type MathRange = { from: number; to: number; tex: string; display: boolean };

const displayMathPattern = /\$\$([\s\S]+?)\$\$/g;
const inlineMathPattern = /(?<![\\$])\$(?!\s|\$)([^$\n]+?)(?<![\s\\])\$(?!\d|\$)/g;

export function mathRanges(source: string): MathRange[] {
  const excluded = codeRanges(source);
  const results: MathRange[] = [];
  for (const match of source.matchAll(displayMathPattern)) {
    const from = match.index ?? 0;
    if (containsPosition(excluded, from)) continue;
    const tex = match[1].trim();
    if (!tex) continue;
    results.push({ from, to: from + match[0].length, tex, display: true });
  }
  const displayRanges = results.map(({ from, to }) => ({ from, to }));
  for (const match of source.matchAll(inlineMathPattern)) {
    const from = match.index ?? 0;
    if (containsPosition(excluded, from) || containsPosition(displayRanges, from)) continue;
    results.push({ from, to: from + match[0].length, tex: match[1], display: false });
  }
  return results.sort((left, right) => left.from - right.from);
}

export type QuoteLineRange = { lineFrom: number; markerFrom: number; markerTo: number; depth: number };

export function quoteLineRanges(source: string): QuoteLineRange[] {
  const excluded = fencedCodeRanges(source);
  const lines = source.split('\n');
  const results: QuoteLineRange[] = [];
  let offset = 0;
  for (const line of lines) {
    const match = line.match(/^( {0,3})((?:> ?)+)/);
    if (match && !containsPosition(excluded, offset)) {
      results.push({
        lineFrom: offset,
        markerFrom: offset + match[1].length,
        markerTo: offset + match[1].length + match[2].length,
        depth: (match[2].match(/>/g) ?? []).length,
      });
    }
    offset += line.length + 1;
  }
  return results;
}

export function horizontalRuleRanges(source: string): SourceRange[] {
  const excluded = fencedCodeRanges(source);
  const lines = source.split('\n');
  const results: SourceRange[] = [];
  let offset = 0;
  for (const line of lines) {
    if (horizontalRulePattern.test(line) && !containsPosition(excluded, offset)) {
      results.push({ from: offset, to: offset + line.length });
    }
    offset += line.length + 1;
  }
  return results;
}

export function inlineCodeRanges(
  source: string,
  excluded: SourceRange[],
): InlineCodeRange[] {
  const ranges: InlineCodeRange[] = [];
  const pattern = /(`+)([^\n]*?)\1/g;
  for (const match of source.matchAll(pattern)) {
    const from = match.index ?? 0;
    if (containsPosition(excluded, from)) continue;
    const markerLength = match[1].length;
    if (!match[2] || match[2].includes('`'.repeat(markerLength))) continue;
    ranges.push({ from, to: from + match[0].length, markerLength });
  }
  return ranges;
}
