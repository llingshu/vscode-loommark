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
