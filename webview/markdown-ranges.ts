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

const imagePattern = /!\[([^\]\n]*)\]\(([^\s)]+)(?:\s+["'][^"'\n]*["'])?\)/g;

export function imageRanges(source: string): ImageRange[] {
  const excluded = codeRanges(source);
  const results: ImageRange[] = [];
  for (const match of source.matchAll(imagePattern)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (containsPosition(excluded, from)) continue;
    const lineStart = source.lastIndexOf('\n', from - 1) + 1;
    const lineBreak = source.indexOf('\n', to);
    const lineEnd = lineBreak < 0 ? source.length : lineBreak;
    results.push({
      from,
      to,
      alt: match[1],
      src: match[2],
      ownLine: source.slice(lineStart, lineEnd).trim() === match[0],
    });
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
