import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detailedFencedCodeRanges,
  fencedCodeRanges,
  inlineCodeRanges,
  imageRanges,
  tableRanges,
} from '../out/test/markdown-ranges.mjs';

test('parses a fenced code block with language', () => {
  const source = 'before\n```ts\nconst x = 1;\n```\nafter';
  const [block] = detailedFencedCodeRanges(source);
  assert.equal(block.language, 'ts');
  assert.equal(block.code, 'const x = 1;');
  assert.equal(source.slice(block.openFrom, block.openTo), '```ts');
});

test('keeps an unterminated fence open to end of source', () => {
  const source = '```\ncode line';
  const [block] = detailedFencedCodeRanges(source);
  assert.equal(block.closeFrom, undefined);
  assert.equal(block.code, 'code line');
});

test('inline code is excluded inside fenced blocks', () => {
  const source = '```\n`not inline`\n```\nreal `inline` here';
  const ranges = inlineCodeRanges(source, fencedCodeRanges(source));
  assert.equal(ranges.length, 1);
  assert.equal(source.slice(ranges[0].from, ranges[0].to), '`inline`');
});

test('parses a basic table with offsets', () => {
  const source = '| Name | Count |\n| --- | ---: |\n| Apple | 3 |\n| Pear | 12 |';
  const [table] = tableRanges(source);
  assert.equal(table.from, 0);
  assert.equal(table.to, source.length);
  assert.deepEqual(table.header.map((cell) => cell.text), ['Name', 'Count']);
  assert.deepEqual(table.alignments, [null, 'right']);
  assert.equal(table.rows.length, 2);
  assert.equal(source.slice(table.rows[0][0].from, table.rows[0][0].to), 'Apple');
});

test('parses all alignment kinds', () => {
  const source = '| a | b | c | d |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |';
  const [table] = tableRanges(source);
  assert.deepEqual(table.alignments, ['left', 'center', 'right', null]);
});

test('unescapes escaped pipes inside cells', () => {
  const source = '| a | b |\n| --- | --- |\n| x \\| y | z |';
  const [table] = tableRanges(source);
  assert.equal(table.rows[0][0].text, 'x | y');
});

test('rejects a header/delimiter column count mismatch', () => {
  const source = '| a | b |\n| --- |\n| 1 | 2 |';
  assert.equal(tableRanges(source).length, 0);
});

test('ignores tables inside fenced code blocks', () => {
  const source = '```\n| a | b |\n| --- | --- |\n```';
  assert.equal(tableRanges(source).length, 0);
});

test('table ends at the first line without a pipe', () => {
  const source = '| a |\n| --- |\n| 1 |\nplain text';
  const [table] = tableRanges(source);
  assert.equal(source.slice(table.from, table.to), '| a |\n| --- |\n| 1 |');
});

test('parses an own-line image', () => {
  const source = 'before\n![diagram](img/a.png)\nafter';
  const [image] = imageRanges(source);
  assert.equal(image.alt, 'diagram');
  assert.equal(image.src, 'img/a.png');
  assert.equal(image.ownLine, true);
});

test('parses an inline image and a titled image', () => {
  const source = 'see ![icon](i.svg "The icon") here';
  const [image] = imageRanges(source);
  assert.equal(image.ownLine, false);
  assert.equal(image.src, 'i.svg');
  assert.equal(source.slice(image.from, image.to), '![icon](i.svg "The icon")');
});

test('ignores images inside code', () => {
  const source = '```\n![a](b.png)\n```\nand `![c](d.png)` too';
  assert.equal(imageRanges(source).length, 0);
});
