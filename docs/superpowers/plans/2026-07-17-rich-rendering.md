# LoomMark 富渲染增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 LoomMark 的 CodeMirror 6 编辑器补齐图片预览、GFM 表格、任务列表/列表、引用块/水平线的"预览切换式"富渲染。

**Architecture:** 纯解析函数集中到新模块 `webview/markdown-ranges.ts`（无 DOM，node 可测）；所有 `WidgetType` 集中到 `webview/widgets.ts`；`main.ts` 用 `StateField` 提供块级替换装饰（CodeMirror 限制：block decoration 不能来自 ViewPlugin），在 `docChanged || selection` 时重建，光标在语法范围内时回退为源码显示。

**Tech Stack:** TypeScript (strict)、CodeMirror 6、esbuild、`node --test`。

**Spec:** `docs/superpowers/specs/2026-07-17-rich-rendering-design.md`

## Global Constraints

- Node.js 20+；VS Code 1.95+；TypeScript `strict: true`，`tsc --noEmit` 必须零错误。
- 测试命令：`npm run check`（= `tsc --noEmit` + node 测试）。测试运行前需先用 esbuild 把 `webview/markdown-ranges.ts` 打包为 `out/test/markdown-ranges.mjs`（Task 2 建立此设施）。
- 所有面向用户的字符串用英文；CSS 优先使用 `var(--vscode-*)` 变量。
- 类名前缀 `cm-loommark-`，与现有代码一致。
- 所有 widget `contentEditable = 'false'`（或天然不可编辑），交互通过 `view.dispatch` 修改源码/光标，不直接改 DOM 文本。
- 提交信息用 `feat:`/`refactor:`/`test:` 前缀，结尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 已知限制（接受，不处理）：setext 标题下划线 `---` 会被当作水平线渲染（现有编辑器本就不支持 setext 标题）。

---

### Task 1: 提交在制的代码块增强

**Files:**
- 无新文件；提交现有工作区改动：`package.json`、`package-lock.json`、`webview/main.ts`、`webview/style.css`

**Interfaces:**
- Consumes: 无
- Produces: 干净的工作区，后续任务基于此提交

- [ ] **Step 1: 验证现有改动通过检查**

Run: `npm run check`
Expected: `tsc` 零错误，6 个测试全部 pass。

- [ ] **Step 2: 验证构建**

Run: `npm run compile`
Expected: esbuild 输出 `dist/extension.js`、`dist/webview.js`，无错误。

- [ ] **Step 3: 提交**

```bash
git add package.json package-lock.json webview/main.ts webview/style.css
git commit -m "feat: add code block toolbar, line numbers, and syntax highlighting

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 抽出 markdown-ranges 解析模块 + 测试打包设施

**Files:**
- Create: `webview/markdown-ranges.ts`
- Create: `scripts/build-test-bundle.mjs`
- Create: `test/markdown-ranges.test.mjs`
- Modify: `webview/main.ts`（删除被移走的函数/类型，改为 import）
- Modify: `package.json`（scripts.test、scripts.check）
- Modify: `.gitignore`（加 `/out/`）

**Interfaces:**
- Consumes: 现有 `main.ts` 中的 `containsPosition`、`codeRanges`、`fencedCodeRanges`、`detailedFencedCodeRanges`、`inlineCodeRanges`、`FencedCodeRange`（全部原样移动）
- Produces（后续任务全部依赖）:
  - `export type SourceRange = { from: number; to: number }`
  - `export type InlineCodeRange = SourceRange & { markerLength: number }`
  - `export type FencedCodeRange`（字段与现 main.ts 中定义完全一致）
  - `export function containsPosition(ranges: SourceRange[], position: number): boolean`
  - `export function codeRanges(source: string): SourceRange[]`
  - `export function fencedCodeRanges(source: string): SourceRange[]`
  - `export function detailedFencedCodeRanges(source: string): FencedCodeRange[]`
  - `export function inlineCodeRanges(source: string, excluded: SourceRange[]): InlineCodeRange[]`

- [ ] **Step 1: 创建 `webview/markdown-ranges.ts`**

把 main.ts 中下列内容**原样移动**（逻辑零改动，只加 `export` 和类型别名）：`containsPosition`、`codeRanges`、`fencedCodeRanges`、`FencedCodeRange` 类型、`detailedFencedCodeRanges`、`inlineCodeRanges`。文件开头补充：

```ts
export type SourceRange = { from: number; to: number };
export type InlineCodeRange = SourceRange & { markerLength: number };
```

函数签名统一改用 `SourceRange`（如 `containsPosition(ranges: SourceRange[], position: number)`），函数体保持不变。`inlineCodeRanges` 返回类型改为 `InlineCodeRange[]`。

- [ ] **Step 2: 修改 `webview/main.ts`**

删除被移动的函数与 `FencedCodeRange` 类型定义，在 import 区加：

```ts
import {
  codeRanges,
  containsPosition,
  detailedFencedCodeRanges,
  fencedCodeRanges,
  inlineCodeRanges,
  type FencedCodeRange,
} from './markdown-ranges';
```

- [ ] **Step 3: 创建 `scripts/build-test-bundle.mjs`**

```js
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['webview/markdown-ranges.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: 'out/test/markdown-ranges.mjs',
  logLevel: 'warning',
});
```

- [ ] **Step 4: 更新 `package.json` scripts 与 `.gitignore`**

```json
"test": "node scripts/build-test-bundle.mjs && node --test test/*.test.mjs",
"check": "tsc --noEmit && npm run test",
```

`.gitignore` 的 "Dependencies and generated output" 段加一行 `/out/`。

- [ ] **Step 5: 写移动后代码的基线测试 `test/markdown-ranges.test.mjs`**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detailedFencedCodeRanges,
  fencedCodeRanges,
  inlineCodeRanges,
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
```

- [ ] **Step 6: 运行检查**

Run: `npm run check`
Expected: tsc 零错误；9 个测试 pass（原 6 + 新 3）。

- [ ] **Step 7: 提交**

```bash
git add webview/markdown-ranges.ts webview/main.ts scripts/build-test-bundle.mjs test/markdown-ranges.test.mjs package.json .gitignore
git commit -m "refactor: extract pure markdown range parsing into testable module

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: GFM 表格解析（纯函数 + 测试）

**Files:**
- Modify: `webview/markdown-ranges.ts`（追加）
- Test: `test/markdown-ranges.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 2 的 `fencedCodeRanges`、`containsPosition`
- Produces（Task 4 依赖）:
  - `export type TableCell = { text: string; from: number; to: number }`
  - `export type TableAlignment = 'left' | 'center' | 'right' | null`
  - `export type TableRange = { from: number; to: number; alignments: TableAlignment[]; header: TableCell[]; rows: TableCell[][] }`
  - `export function tableRanges(source: string): TableRange[]`

- [ ] **Step 1: 先写失败的测试（追加到 `test/markdown-ranges.test.mjs`）**

import 行加入 `tableRanges`。

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test`
Expected: FAIL — `tableRanges` 未导出（SyntaxError: The requested module does not provide an export named 'tableRanges'）。

- [ ] **Step 3: 在 `webview/markdown-ranges.ts` 实现**

```ts
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
```

- [ ] **Step 4: 运行检查**

Run: `npm run check`
Expected: tsc 零错误；15 个测试全部 pass。

- [ ] **Step 5: 提交**

```bash
git add webview/markdown-ranges.ts test/markdown-ranges.test.mjs
git commit -m "feat: parse GFM table blocks with cell source offsets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 表格 widget + StateField + CSS（创建 widgets.ts）

**Files:**
- Create: `webview/widgets.ts`
- Modify: `webview/main.ts`
- Modify: `webview/style.css`（追加）

**Interfaces:**
- Consumes: Task 3 的 `TableRange`/`TableCell`/`tableRanges`；main.ts 现有 `CodeToolbarWidget`、`isTerminalLanguage`、`codeLanguages`（移入 widgets.ts）
- Produces（Task 5/6 依赖）:
  - `webview/widgets.ts`：`export class CodeToolbarWidget`（原样移入）、`export class TableWidget`（构造 `(table: TableRange, source: string)`）、`export function renderInlineMarkdown(text: string): DocumentFragment`
  - `webview/main.ts`：`function selectionAwareField(build: (state: EditorState) => DecorationSet): StateField<DecorationSet>` 帮助函数（模块内私有，后续任务在同文件使用）

- [ ] **Step 1: 创建 `webview/widgets.ts`**

从 main.ts **原样移入** `codeLanguages`、`CodeToolbarWidget`、`isTerminalLanguage`（加 `export`），并新增：

```ts
import { EditorView, WidgetType } from '@codemirror/view';
import type { FencedCodeRange, TableCell, TableRange } from './markdown-ranges';

// ...（移入的 codeLanguages / CodeToolbarWidget / isTerminalLanguage）...

export function renderInlineMarkdown(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const pattern = /(\*\*|__)(?=\S)(.+?\S)\1|(?<![*_])([*_])(?![*_])(?=\S)(.+?\S)\3(?![*_])|~~(?=\S)(.+?\S)~~|`([^`\n]+)`|\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) fragment.append(text.slice(last, index));
    if (match[2] !== undefined) {
      const element = document.createElement('strong');
      element.textContent = match[2];
      fragment.append(element);
    } else if (match[4] !== undefined) {
      const element = document.createElement('em');
      element.textContent = match[4];
      fragment.append(element);
    } else if (match[5] !== undefined) {
      const element = document.createElement('s');
      element.textContent = match[5];
      fragment.append(element);
    } else if (match[6] !== undefined) {
      const element = document.createElement('code');
      element.textContent = match[6];
      fragment.append(element);
    } else {
      const element = document.createElement('span');
      element.className = 'cm-loommark-link';
      element.textContent = match[7];
      fragment.append(element);
    }
    last = index + match[0].length;
  }
  if (last < text.length) fragment.append(text.slice(last));
  return fragment;
}

export class TableWidget extends WidgetType {
  constructor(
    private readonly table: TableRange,
    private readonly source: string,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return this.table.from === other.table.from && this.source === other.source;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-loommark-table';
    container.contentEditable = 'false';
    const table = document.createElement('table');
    const head = document.createElement('thead');
    head.append(this.renderRow(view, this.table.header, 'th'));
    const body = document.createElement('tbody');
    for (const row of this.table.rows) body.append(this.renderRow(view, row, 'td'));
    table.append(head, body);
    container.append(table);
    return container;
  }

  ignoreEvent(): boolean {
    return true;
  }

  private renderRow(view: EditorView, cells: TableCell[], tag: 'th' | 'td'): HTMLTableRowElement {
    const row = document.createElement('tr');
    cells.forEach((cell, column) => {
      const element = document.createElement(tag);
      const alignment = this.table.alignments[column];
      if (alignment) element.style.textAlign = alignment;
      element.append(renderInlineMarkdown(cell.text));
      element.addEventListener('mousedown', (event) => {
        event.preventDefault();
        view.dispatch({
          selection: { anchor: Math.min(cell.to, view.state.doc.length) },
          scrollIntoView: true,
        });
        view.focus();
      });
      row.append(element);
    });
    return row;
  }
}
```

- [ ] **Step 2: 修改 `webview/main.ts`**

1. 删除 `codeLanguages`、`CodeToolbarWidget`、`isTerminalLanguage`；从 `@codemirror/view` 的 import 中移除 `WidgetType`；加 `import { CodeToolbarWidget, TableWidget } from './widgets';`，并在 markdown-ranges 的 import 中加入 `tableRanges`。
2. 加帮助函数与 tableField（放在 `codeToolbarField` 之后）：

```ts
function selectionAwareField(build: (state: EditorState) => DecorationSet): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: build,
    update(value, transaction) {
      if (transaction.docChanged || transaction.selection) return build(transaction.state);
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

const tableField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const cursor = state.selection.main.head;
  const source = state.doc.toString();
  for (const table of tableRanges(source)) {
    if (cursor >= table.from && cursor <= table.to) continue;
    ranges.push(Decoration.replace({
      widget: new TableWidget(table, source.slice(table.from, table.to)),
      block: true,
    }).range(table.from, table.to));
  }
  return Decoration.set(ranges, true);
});
```

3. 在 `createEditor` 的 extensions 数组中 `codeToolbarField` 后注册 `tableField`。

- [ ] **Step 3: 追加 CSS 到 `webview/style.css`**

```css
#editor > .cm-editor .cm-loommark-table {
  padding: 4px 0;
}

#editor > .cm-editor .cm-loommark-table table {
  max-width: 100%;
  border-collapse: collapse;
}

#editor > .cm-editor .cm-loommark-table th,
#editor > .cm-editor .cm-loommark-table td {
  padding: 4px 12px;
  border: 1px solid var(--vscode-widget-border, #666666);
  cursor: pointer;
  text-align: left;
}

#editor > .cm-editor .cm-loommark-table th {
  background: var(--vscode-editorWidget-background);
  font-weight: 600;
}

#editor > .cm-editor .cm-loommark-table td:hover {
  background: var(--vscode-list-hoverBackground);
}
```

- [ ] **Step 4: 运行检查与构建**

Run: `npm run check && npm run compile`
Expected: tsc 零错误，15 测试 pass，esbuild 构建成功。

- [ ] **Step 5: 手动验证（Extension Development Host）**

VS Code 中按 F5，打开含表格的 md 文件：光标在表格外 → 渲染为真实表格；点击单元格 → 展开源码且光标落在该单元格文本末尾；表内粗体/行内代码正确渲染。

- [ ] **Step 6: 提交**

```bash
git add webview/widgets.ts webview/main.ts webview/style.css
git commit -m "feat: render GFM tables as widgets with click-to-edit cells

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: 图片预览

**Files:**
- Modify: `webview/markdown-ranges.ts`（追加 `imageRanges`）
- Modify: `webview/widgets.ts`（追加 `ImageWidget`、`resolveImageSource`）
- Modify: `webview/main.ts`（resourceBase 状态、imageField、链接装饰排除图片）
- Modify: `webview/style.css`（追加）
- Test: `test/markdown-ranges.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 2 的 `codeRanges`/`containsPosition`；Task 4 的 `selectionAwareField`
- Produces:
  - `export type ImageRange = { from: number; to: number; alt: string; src: string; ownLine: boolean }`
  - `export function imageRanges(source: string): ImageRange[]`
  - `export class ImageWidget`（构造 `(image: ImageRange, resourceBase: string, block: boolean)`）
  - `export function resolveImageSource(src: string, resourceBase: string): string`

- [ ] **Step 1: 先写失败的测试（追加）**

import 行加入 `imageRanges`。

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test`
Expected: FAIL — `imageRanges` 未导出。

- [ ] **Step 3: 在 `webview/markdown-ranges.ts` 实现**

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test`
Expected: 18 个测试全部 pass。

- [ ] **Step 5: 在 `webview/widgets.ts` 追加 widget**

import 行补 `ImageRange`。

```ts
export function resolveImageSource(src: string, resourceBase: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('//')) return src;
  return resourceBase + src.replace(/^\.\//, '');
}

export class ImageWidget extends WidgetType {
  constructor(
    private readonly image: ImageRange,
    private readonly resourceBase: string,
    private readonly block: boolean,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return this.image.from === other.image.from
      && this.image.src === other.image.src
      && this.image.alt === other.image.alt
      && this.resourceBase === other.resourceBase;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement(this.block ? 'div' : 'span');
    container.className = `cm-loommark-image${this.block ? ' is-block' : ''}`;
    container.contentEditable = 'false';
    const img = document.createElement('img');
    img.src = resolveImageSource(this.image.src, this.resourceBase);
    img.alt = this.image.alt;
    img.addEventListener('error', () => {
      const failure = document.createElement('span');
      failure.className = 'cm-loommark-image-error';
      failure.textContent = `Image not found: ${this.image.alt || 'image'} (${this.image.src})`;
      img.replaceWith(failure);
    });
    container.addEventListener('mousedown', (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.image.from }, scrollIntoView: true });
      view.focus();
    });
    container.append(img);
    return container;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
```

- [ ] **Step 6: 修改 `webview/main.ts`**

1. widgets import 加 `ImageWidget`；markdown-ranges import 加 `imageRanges`。
2. 状态区加 `let resourceBase = '';`，在 `init` 消息处理中 `createEditor` 之前加 `resourceBase = message.resourceBase;`。
3. `tableField` 后加：

```ts
const imageField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const cursor = state.selection.main.head;
  const source = state.doc.toString();
  for (const image of imageRanges(source)) {
    if (image.ownLine) {
      const line = state.doc.lineAt(image.from);
      if (cursor >= line.from && cursor <= line.to) continue;
      ranges.push(Decoration.replace({
        widget: new ImageWidget(image, resourceBase, true),
        block: true,
      }).range(line.from, line.to));
    } else {
      if (cursor >= image.from && cursor <= image.to) continue;
      ranges.push(Decoration.replace({
        widget: new ImageWidget(image, resourceBase, false),
      }).range(image.from, image.to));
    }
  }
  return Decoration.set(ranges, true);
});
```

4. extensions 数组注册 `imageField`（`tableField` 之后）。
5. 修复链接装饰误匹配图片：`buildLinkDecorations` 的 `linkPattern` 循环内，`const from = match.index ?? 0;` 之后加：

```ts
if (from > 0 && source[from - 1] === '!') continue;
```

- [ ] **Step 7: 追加 CSS**

```css
#editor > .cm-editor .cm-loommark-image img {
  max-width: 100%;
  max-height: 480px;
  border-radius: 4px;
  cursor: pointer;
}

#editor > .cm-editor .cm-loommark-image.is-block {
  display: block;
  padding: 4px 0;
}

#editor > .cm-editor .cm-loommark-image-error {
  color: var(--vscode-errorForeground);
  font-size: 0.9em;
}
```

- [ ] **Step 8: 运行检查、手动验证、提交**

Run: `npm run check && npm run compile`（tsc 零错误，18 测试 pass）。
F5 验证：独占行图片渲染为块级图片、行内图片内联显示、相对路径与 https 图片均可加载、坏路径显示占位文本、点击图片展开源码、`[链接](x)` 不再把图片当链接渲染。

```bash
git add webview/markdown-ranges.ts webview/widgets.ts webview/main.ts webview/style.css test/markdown-ranges.test.mjs
git commit -m "feat: render markdown images inline using webview resource base

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: 任务列表复选框 + 列表符号

**Files:**
- Modify: `webview/markdown-ranges.ts`（追加 `listItemRanges`）
- Modify: `webview/widgets.ts`（追加 `CheckboxWidget`、`BulletWidget`）
- Modify: `webview/main.ts`（listField）
- Modify: `webview/style.css`（追加）
- Test: `test/markdown-ranges.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 2 的 `fencedCodeRanges`/`containsPosition`；Task 4 的 `selectionAwareField`
- Produces:
  - `export type ListItemRange = { lineFrom: number; lineTo: number; markerFrom: number; markerTo: number; level: number; ordered: boolean; task?: { checked: boolean; boxFrom: number; boxTo: number } }`
  - `export function listItemRanges(source: string): ListItemRange[]`
  - `export class CheckboxWidget`（构造 `(checked: boolean, boxFrom: number)`）
  - `export class BulletWidget`（构造 `(level: number)`）

- [ ] **Step 1: 先写失败的测试（追加）**

import 行加入 `listItemRanges`。

```js
test('parses bullet levels and marker offsets', () => {
  const source = '- top\n  - nested\n    * deep';
  const items = listItemRanges(source);
  assert.deepEqual(items.map((item) => item.level), [0, 1, 2]);
  assert.equal(source.slice(items[1].markerFrom, items[1].markerTo), '-');
  assert.equal(items.every((item) => !item.ordered), true);
});

test('parses ordered and task items', () => {
  const source = '1. first\n- [ ] todo\n- [x] done';
  const items = listItemRanges(source);
  assert.equal(items[0].ordered, true);
  assert.equal(items[0].task, undefined);
  assert.equal(items[1].task.checked, false);
  assert.equal(items[2].task.checked, true);
  assert.equal(source.slice(items[1].task.boxFrom, items[1].task.boxTo), '[ ]');
});

test('does not treat horizontal rules or code as list items', () => {
  const source = '- - -\n```\n- in code\n```';
  assert.equal(listItemRanges(source).length, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test`
Expected: FAIL — `listItemRanges` 未导出。

- [ ] **Step 3: 在 `webview/markdown-ranges.ts` 实现**

```ts
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
      if (match[6] !== undefined) {
        const boxFrom = markerTo + match[5].length;
        item.task = { checked: match[7].toLowerCase() === 'x', boxFrom, boxTo: boxFrom + 3 };
      }
      results.push(item);
    }
    offset += line.length + 1;
  }
  return results;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test`
Expected: 21 个测试全部 pass。

- [ ] **Step 5: 在 `webview/widgets.ts` 追加 widget**

```ts
const bulletCharacters = ['•', '◦', '▪'];

export class BulletWidget extends WidgetType {
  constructor(private readonly level: number) {
    super();
  }

  eq(other: BulletWidget): boolean {
    return this.level === other.level;
  }

  toDOM(): HTMLElement {
    const bullet = document.createElement('span');
    bullet.className = 'cm-loommark-bullet';
    bullet.textContent = bulletCharacters[this.level % bulletCharacters.length];
    return bullet;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly boxFrom: number,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return this.checked === other.checked && this.boxFrom === other.boxFrom;
  }

  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'cm-loommark-checkbox';
    input.setAttribute('aria-label', this.checked ? 'Mark task as not done' : 'Mark task as done');
    input.addEventListener('mousedown', (event) => event.preventDefault());
    input.addEventListener('click', (event) => {
      event.preventDefault();
      view.dispatch({
        changes: { from: this.boxFrom + 1, to: this.boxFrom + 2, insert: this.checked ? ' ' : 'x' },
      });
    });
    return input;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
```

- [ ] **Step 6: 在 `webview/main.ts` 加 listField 并注册**

widgets import 加 `BulletWidget, CheckboxWidget`；markdown-ranges import 加 `listItemRanges`。

```ts
const listField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const cursor = state.selection.main.head;
  const source = state.doc.toString();
  for (const item of listItemRanges(source)) {
    if (item.task?.checked) {
      ranges.push(Decoration.line({
        attributes: { class: 'cm-loommark-task-done' },
      }).range(item.lineFrom));
    }
    if (cursor >= item.lineFrom && cursor <= item.lineTo) continue;
    if (!item.ordered) {
      ranges.push(Decoration.replace({ widget: new BulletWidget(item.level) })
        .range(item.markerFrom, item.markerTo));
    }
    if (item.task) {
      ranges.push(Decoration.replace({ widget: new CheckboxWidget(item.task.checked, item.task.boxFrom) })
        .range(item.task.boxFrom, item.task.boxTo));
    }
  }
  return Decoration.set(ranges, true);
});
```

extensions 数组注册 `listField`（`imageField` 之后）。

- [ ] **Step 7: 追加 CSS**

```css
#editor > .cm-editor .cm-loommark-bullet {
  display: inline-block;
  width: 1ch;
  color: var(--vscode-descriptionForeground);
}

#editor > .cm-editor .cm-loommark-checkbox {
  margin: 0 2px 2px 0;
  vertical-align: middle;
  accent-color: var(--vscode-focusBorder);
  cursor: pointer;
}

#editor > .cm-editor .cm-loommark-task-done {
  opacity: 0.65;
}
```

- [ ] **Step 8: 运行检查、手动验证、提交**

Run: `npm run check && npm run compile`（tsc 零错误，21 测试 pass）。
F5 验证：`- [ ]` 显示复选框，点击直接打勾（源码变 `[x]`）且光标不跳动；已完成任务行变暗；无序列表按层级显示 `•` `◦` `▪`；光标进入行内显示源码。

```bash
git add webview/markdown-ranges.ts webview/widgets.ts webview/main.ts webview/style.css test/markdown-ranges.test.mjs
git commit -m "feat: add clickable task checkboxes and styled list bullets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: 引用块 + 水平线

**Files:**
- Modify: `webview/markdown-ranges.ts`（追加 `quoteLineRanges`、`horizontalRuleRanges`）
- Modify: `webview/widgets.ts`（追加 `HorizontalRuleWidget`）
- Modify: `webview/main.ts`（quoteField）
- Modify: `webview/style.css`（追加）
- Test: `test/markdown-ranges.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 2 的 `fencedCodeRanges`/`containsPosition`；Task 4 的 `selectionAwareField`；Task 6 已定义的 `horizontalRulePattern`（模块内复用）
- Produces:
  - `export type QuoteLineRange = { lineFrom: number; markerFrom: number; markerTo: number; depth: number }`
  - `export function quoteLineRanges(source: string): QuoteLineRange[]`
  - `export function horizontalRuleRanges(source: string): SourceRange[]`
  - `export class HorizontalRuleWidget`（无参构造）

- [ ] **Step 1: 先写失败的测试（追加）**

import 行加入 `quoteLineRanges, horizontalRuleRanges`。

```js
test('parses quote lines with depth and marker offsets', () => {
  const source = '> outer\n> > inner\nplain';
  const quotes = quoteLineRanges(source);
  assert.equal(quotes.length, 2);
  assert.deepEqual(quotes.map((quote) => quote.depth), [1, 2]);
  assert.equal(source.slice(quotes[1].markerFrom, quotes[1].markerTo), '> > ');
});

test('parses horizontal rules and excludes code', () => {
  const source = '---\n***\n___\n```\n---\n```';
  const rules = horizontalRuleRanges(source);
  assert.equal(rules.length, 3);
  assert.equal(source.slice(rules[0].from, rules[0].to), '---');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test`
Expected: FAIL — `quoteLineRanges` 未导出。

- [ ] **Step 3: 在 `webview/markdown-ranges.ts` 实现**

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test`
Expected: 23 个测试全部 pass。

- [ ] **Step 5: 在 `webview/widgets.ts` 追加**

```ts
export class HorizontalRuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const rule = document.createElement('span');
    rule.className = 'cm-loommark-hr';
    return rule;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
```

- [ ] **Step 6: 在 `webview/main.ts` 加 quoteField 并注册**

widgets import 加 `HorizontalRuleWidget`；markdown-ranges import 加 `quoteLineRanges, horizontalRuleRanges`。

```ts
const quoteField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const cursor = state.selection.main.head;
  const source = state.doc.toString();
  for (const quote of quoteLineRanges(source)) {
    const line = state.doc.lineAt(quote.lineFrom);
    ranges.push(Decoration.line({
      attributes: { class: `cm-loommark-quote cm-loommark-quote-depth-${Math.min(quote.depth, 3)}` },
    }).range(line.from));
    if (!(cursor >= line.from && cursor <= line.to)) {
      ranges.push(Decoration.replace({}).range(quote.markerFrom, quote.markerTo));
    }
  }
  for (const rule of horizontalRuleRanges(source)) {
    const line = state.doc.lineAt(rule.from);
    if (cursor >= line.from && cursor <= line.to) continue;
    ranges.push(Decoration.replace({ widget: new HorizontalRuleWidget() }).range(rule.from, rule.to));
  }
  return Decoration.set(ranges, true);
});
```

extensions 数组注册 `quoteField`（`listField` 之后）。

- [ ] **Step 7: 追加 CSS**

```css
#editor > .cm-editor .cm-loommark-quote {
  border-left: 3px solid var(--vscode-textBlockQuote-border, #888888);
  background: var(--vscode-textBlockQuote-background, transparent);
  padding-left: 12px;
  color: var(--vscode-descriptionForeground);
}

#editor > .cm-editor .cm-loommark-quote-depth-2 {
  border-left-width: 3px;
  box-shadow: inset 6px 0 0 -3px var(--vscode-textBlockQuote-border, #888888);
}

#editor > .cm-editor .cm-loommark-hr {
  display: inline-block;
  width: 100%;
  height: 2px;
  vertical-align: middle;
  background: var(--vscode-widget-border, #666666);
}
```

- [ ] **Step 8: 运行检查、手动验证、提交**

Run: `npm run check && npm run compile`（tsc 零错误，23 测试 pass）。
F5 验证：`>` 行显示左侧竖线且标记隐藏、光标进入显示 `>`；`---` 渲染为分隔线、光标进入还原。

```bash
git add webview/markdown-ranges.ts webview/widgets.ts webview/main.ts webview/style.css test/markdown-ranges.test.mjs
git commit -m "feat: style blockquotes and render horizontal rules

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: 浅色主题衔接修正 + 演示文档 + 最终验证

**Files:**
- Modify: `webview/style.css`（代码块工具栏边框）
- Create: `test/fixtures/rich-rendering-demo.md`

**Interfaces:**
- Consumes: Task 1–7 的全部成果
- Produces: 统一的手动验证 fixture 与最终绿色状态

- [ ] **Step 1: 统一代码块工具栏与代码体的边框颜色**

`webview/style.css` 中 `.cm-loommark-code-toolbar` 的 `border: 1px solid #cfd1d6;` 改为 `border: 1px solid #383a40;`，使工具栏边框与代码体侧边框（`#383a40`）在明暗主题下均无错缝。

- [ ] **Step 2: 创建 `test/fixtures/rich-rendering-demo.md`**

```markdown
# Rich Rendering Demo

## Table

| Name | Count | Price |
| :--- | :---: | ---: |
| Apple | 3 | $1.50 |
| **Pear** | `12` | $0.75 |

## Images

![Remote](https://raw.githubusercontent.com/microsoft/vscode/main/resources/linux/code.png)

Inline ![icon](./missing.png) placeholder demo.

## Tasks

- [ ] Write the report
- [x] Review the spec
- Regular bullet
  - Nested bullet
    - Deep bullet

1. Ordered stays numeric

## Quote and rule

> Outer quote
> > Nested quote

---

Done.
```

- [ ] **Step 3: 最终检查与构建**

Run: `npm run check && npm run compile`
Expected: tsc 零错误，23 测试全部 pass，构建成功。

- [ ] **Step 4: 综合手动验证**

F5 打开 `test/fixtures/rich-rendering-demo.md`，在浅色与深色主题下各过一遍：表格、远程图片、坏图占位、复选框点击、列表符号、引用、水平线、代码块工具栏无错缝；编辑其中任意区块后保存，用 `Reopen Editor With... > Text Editor` 确认源码未被破坏。

- [ ] **Step 5: 提交**

```bash
git add webview/style.css test/fixtures/rich-rendering-demo.md
git commit -m "feat: align code toolbar border and add rich rendering demo fixture

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
