import { EditorView, WidgetType } from '@codemirror/view';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import type { FencedCodeRange, ImageRange, MathRange, TableCell, TableRange } from './markdown-ranges';
import type { TableMode } from '../src/protocol';

export type BlockCardPresentation = { className: string; style: string } | undefined;

function applyBlockCard(element: HTMLElement, presentation: BlockCardPresentation): void {
  if (!presentation) return;
  element.classList.add(...presentation.className.split(' ').filter(Boolean));
  element.setAttribute('style', presentation.style);
}

export const codeLanguages = [
  '', 'bash', 'shell', 'powershell', 'javascript', 'typescript', 'json', 'python',
  'html', 'css', 'scss', 'sql', 'yaml', 'markdown', 'java', 'c', 'cpp', 'rust', 'go',
];

const codeLanguageLabels: Record<string, string> = {
  '': 'Plain Text',
  bash: 'Bash',
  shell: 'Shell',
  powershell: 'PowerShell',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  json: 'JSON',
  python: 'Python',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  sql: 'SQL',
  yaml: 'YAML',
  markdown: 'Markdown',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  rust: 'Rust',
  go: 'Go',
};

export function languageDisplayName(language: string): string {
  return codeLanguageLabels[language.toLowerCase()] ?? language;
}

export function isTerminalLanguage(language: string): boolean {
  return ['bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'pwsh', 'console', 'terminal'].includes(
    language.toLowerCase(),
  );
}

export class CodeToolbarWidget extends WidgetType {
  constructor(
    private readonly block: FencedCodeRange,
    private readonly card: BlockCardPresentation,
  ) {
    super();
  }

  eq(other: CodeToolbarWidget): boolean {
    return this.block.openFrom === other.block.openFrom
      && this.block.language === other.block.language
      && this.block.code === other.block.code
      && this.card?.className === other.card?.className
      && this.card?.style === other.card?.style;
  }

  toDOM(view: EditorView): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = `cm-loommark-code-toolbar${isTerminalLanguage(this.block.language) ? ' is-terminal' : ''}`;
    toolbar.contentEditable = 'false';

    const chrome = document.createElement('span');
    chrome.className = 'cm-loommark-code-chrome';
    chrome.ariaHidden = 'true';
    chrome.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));

    const select = document.createElement('select');
    select.className = 'cm-loommark-code-language';
    select.title = 'Code language';
    const current = this.block.language.toLowerCase();
    const options = current && !codeLanguages.includes(current) ? [current, ...codeLanguages] : codeLanguages;
    for (const language of options) {
      const option = document.createElement('option');
      option.value = language;
      option.textContent = languageDisplayName(language);
      option.selected = language === current;
      select.append(option);
    }
    select.addEventListener('change', () => {
      view.dispatch({
        changes: {
          from: this.block.languageFrom,
          to: this.block.languageTo,
          insert: select.value,
        },
      });
      view.focus();
    });

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'cm-loommark-code-copy';
    copy.title = 'Copy code';
    copy.setAttribute('aria-label', 'Copy code');
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(this.block.code);
      copy.textContent = 'Copied';
      window.setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    });

    toolbar.append(chrome, select, copy);
    if (!this.card) return toolbar;
    const shell = document.createElement('div');
    shell.className = 'cm-loommark-block-card-shell';
    applyBlockCard(shell, this.card);
    shell.append(toolbar);
    return shell;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

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

export class OrderedLabelWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly delimiter: string,
    private readonly markerTo: number,
  ) {
    super();
  }

  eq(other: OrderedLabelWidget): boolean {
    return this.label === other.label
      && this.delimiter === other.delimiter
      && this.markerTo === other.markerTo;
  }

  toDOM(view: EditorView): HTMLElement {
    const marker = document.createElement('span');
    marker.className = 'cm-loommark-ordered-label';
    marker.title = 'Click to edit the source number';
    marker.textContent = `${this.label}${this.delimiter}`;
    // The label is a derived display value and never reveals the raw source on its own (see
    // listField), so clicking places the cursor right after the marker — at the start of the
    // item's real content — rather than trying to show the literal digits underneath it.
    marker.addEventListener('mousedown', (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.markerTo }, scrollIntoView: true });
      view.focus();
    });
    return marker;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// Replaces a line's leading whitespace with a fixed-width rail per active ancestor level,
// so alignment stays consistent whether the source has exactly the expected indent (a list
// item line) or a differently-sized one (a continuation paragraph/code block/quote). Rail
// position in the DOM equals its nesting level: ancestor levels are always a contiguous
// chain from 0, so CSS can color by :nth-child without the widget computing colors itself.
export class ListGuideWidget extends WidgetType {
  constructor(
    private readonly levelCount: number,
    private readonly isHighlighted: boolean,
  ) {
    super();
  }

  eq(other: ListGuideWidget): boolean {
    return this.levelCount === other.levelCount && this.isHighlighted === other.isHighlighted;
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = `cm-loommark-list-guide${this.isHighlighted ? ' is-active' : ''}`;
    for (let level = 0; level < this.levelCount; level++) {
      const rail = document.createElement('span');
      rail.className = 'cm-loommark-list-guide-rail';
      container.append(rail);
    }
    return container;
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

export class MathWidget extends WidgetType {
  constructor(
    private readonly math: MathRange,
    private readonly block: boolean,
    private readonly card?: BlockCardPresentation,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return this.math.from === other.math.from
      && this.math.tex === other.math.tex
      && this.math.display === other.math.display
      && this.block === other.block
      && this.card?.style === other.card?.style;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement(this.block ? 'div' : 'span');
    container.className = `cm-loommark-math${this.block ? ' is-block' : ''}`;
    if (this.block) applyBlockCard(container, this.card);
    container.contentEditable = 'false';
    katex.render(this.math.tex, container, {
      displayMode: this.math.display,
      throwOnError: false,
    });
    container.addEventListener('mousedown', (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.math.from }, scrollIntoView: true });
      view.focus();
    });
    return container;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

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

export class QuoteMarkerWidget extends WidgetType {
  constructor(private readonly depth: number) {
    super();
  }

  eq(other: QuoteMarkerWidget): boolean {
    return this.depth === other.depth;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement('span');
    marker.className = 'cm-loommark-quote-marker';
    marker.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < this.depth; index++) {
      marker.append(document.createElement('i'));
    }
    return marker;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class CardBoundaryWidget extends WidgetType {
  constructor(
    private readonly kind: 'open' | 'close',
    private readonly inset: number,
    private readonly gap: number,
    private readonly color: string,
  ) {
    super();
  }

  eq(other: CardBoundaryWidget): boolean {
    return this.kind === other.kind
      && this.inset === other.inset
      && this.gap === other.gap
      && this.color === other.color;
  }

  toDOM(): HTMLElement {
    const boundary = document.createElement('span');
    boundary.className = `cm-loommark-card-boundary is-${this.kind}`;
    boundary.style.setProperty('--loommark-card-boundary-inset', `${this.inset}px`);
    boundary.style.setProperty('--loommark-card-boundary-gap', `${this.gap}px`);
    boundary.style.setProperty('--loommark-card-boundary-color', this.color);
    boundary.setAttribute('aria-hidden', 'true');
    return boundary;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function resolveImageSource(src: string, resourceBase: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('//')) return src;
  return resourceBase + src.replace(/^\.\//, '');
}

export class ImageWidget extends WidgetType {
  constructor(
    private readonly image: ImageRange,
    private readonly resourceBase: string,
    private readonly block: boolean,
    private readonly card?: BlockCardPresentation,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return this.image.from === other.image.from
      && this.image.src === other.image.src
      && this.image.alt === other.image.alt
      && this.resourceBase === other.resourceBase
      && this.card?.style === other.card?.style;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement(this.block ? 'div' : 'span');
    container.className = `cm-loommark-image${this.block ? ' is-block' : ''}`;
    if (this.block) applyBlockCard(container, this.card);
    container.contentEditable = 'false';
    // Ctrl/Cmd + click is handled by the same global `[data-loommark-href]` listener that
    // opens Markdown links, so it opens whether the image is rendered or shown as source.
    container.dataset.loommarkHref = this.image.src;
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

type TableEditFocus = { tableFrom: number; row: number; column: number };
let pendingTableFocus: TableEditFocus | undefined;

function normalizeCellText(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\\\|/g, '|').replace(/\|/g, '\\|').trim();
}

type EditingCell = {
  element: HTMLTableCellElement;
  row: number;
  column: number;
  keydownHandler: (event: KeyboardEvent) => void;
  blurHandler: () => void;
};

export class TableWidget extends WidgetType {
  private allRows: TableCell[][];
  private cellElements: HTMLTableCellElement[][] = [];
  private editing: EditingCell | undefined;

  constructor(
    private readonly table: TableRange,
    private readonly source: string,
    private readonly mode: TableMode,
    private readonly card?: BlockCardPresentation,
  ) {
    super();
    this.allRows = [this.table.header, ...this.table.rows];
  }

  eq(other: TableWidget): boolean {
    return this.table.from === other.table.from
      && this.source === other.source
      && this.mode === other.mode
      && this.card?.className === other.card?.className
      && this.card?.style === other.card?.style;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = `cm-loommark-table${this.mode === 'rich' ? ' is-rich' : ''}`;
    applyBlockCard(container, this.card);
    container.contentEditable = 'false';
    const table = document.createElement('table');
    const head = document.createElement('thead');
    head.append(this.renderRow(view, 0, 'th'));
    const body = document.createElement('tbody');
    for (let rowIndex = 1; rowIndex < this.allRows.length; rowIndex++) {
      body.append(this.renderRow(view, rowIndex, 'td'));
    }
    table.append(head, body);
    container.append(table);
    if (pendingTableFocus && pendingTableFocus.tableFrom === this.table.from) {
      const focus = pendingTableFocus;
      pendingTableFocus = undefined;
      window.setTimeout(() => this.startEditing(view, focus.row, focus.column), 0);
    }
    return container;
  }

  ignoreEvent(): boolean {
    return true;
  }

  private renderRow(view: EditorView, rowIndex: number, tag: 'th' | 'td'): HTMLTableRowElement {
    const cells = this.allRows[rowIndex];
    const row = document.createElement('tr');
    this.cellElements[rowIndex] = [];
    cells.forEach((cell, column) => {
      const element = document.createElement(tag);
      const alignment = this.table.alignments[column];
      if (alignment) element.style.textAlign = alignment;
      element.append(renderInlineMarkdown(cell.text));
      element.addEventListener('mousedown', (event) => {
        if (this.mode === 'rich') {
          if (this.editing?.element === element) return;
          event.preventDefault();
          if (this.editing) {
            pendingTableFocus = { tableFrom: this.table.from, row: rowIndex, column };
            if (this.commitCell(view, this.editing)) return;
            pendingTableFocus = undefined;
          }
          this.startEditing(view, rowIndex, column);
          return;
        }
        event.preventDefault();
        view.dispatch({
          selection: { anchor: Math.min(cell.to, view.state.doc.length) },
          scrollIntoView: true,
        });
        view.focus();
      });
      row.append(element);
      this.cellElements[rowIndex][column] = element;
    });
    return row;
  }

  private rawCellText(cell: TableCell): string {
    return this.source.slice(cell.from - this.table.from, cell.to - this.table.from);
  }

  private startEditing(view: EditorView, rowIndex: number, column: number): void {
    const element = this.cellElements[rowIndex]?.[column];
    const cell = this.allRows[rowIndex]?.[column];
    if (!element || !cell) return;
    const keydownHandler = (event: KeyboardEvent): void => {
      const editing = this.editing;
      if (!editing || editing.element !== element) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitCell(view, editing);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.cancelEditing();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const next = this.siblingCell(editing.row, editing.column, event.shiftKey ? -1 : 1);
        if (next) pendingTableFocus = { tableFrom: this.table.from, ...next };
        if (this.commitCell(view, editing)) return;
        if (next) {
          pendingTableFocus = undefined;
          this.startEditing(view, next.row, next.column);
        }
      }
    };
    const blurHandler = (): void => {
      const editing = this.editing;
      if (editing && editing.element === element) this.commitCell(view, editing);
    };
    this.editing = { element, row: rowIndex, column, keydownHandler, blurHandler };
    element.textContent = this.rawCellText(cell);
    element.contentEditable = 'plaintext-only';
    element.classList.add('is-editing');
    element.addEventListener('keydown', keydownHandler, { capture: true });
    element.addEventListener('blur', blurHandler);
    element.focus();
    const selection = window.getSelection();
    if (selection) {
      selection.selectAllChildren(element);
      selection.collapseToEnd();
    }
  }

  private siblingCell(rowIndex: number, column: number, step: number): { row: number; column: number } | undefined {
    let row = rowIndex;
    let next = column + step;
    while (true) {
      if (next >= 0 && next < this.allRows[row].length) return { row, column: next };
      row += step;
      if (row < 0 || row >= this.allRows.length) return undefined;
      next = step > 0 ? 0 : this.allRows[row].length - 1;
    }
  }

  private commitCell(view: EditorView, editing: EditingCell): boolean {
    const cell = this.allRows[editing.row][editing.column];
    const raw = this.rawCellText(cell);
    const next = normalizeCellText(editing.element.textContent ?? '');
    if (next === raw) {
      this.stopEditing(editing, cell);
      return false;
    }
    this.detachEditing(editing);
    view.dispatch({ changes: { from: cell.from, to: cell.to, insert: next } });
    return true;
  }

  private cancelEditing(): void {
    if (!this.editing) return;
    this.stopEditing(this.editing, this.allRows[this.editing.row][this.editing.column]);
  }

  private stopEditing(editing: EditingCell, cell: TableCell): void {
    this.detachEditing(editing);
    editing.element.replaceChildren(renderInlineMarkdown(cell.text));
    editing.element.blur();
  }

  private detachEditing(editing: EditingCell): void {
    this.editing = undefined;
    editing.element.contentEditable = 'false';
    editing.element.classList.remove('is-editing');
    editing.element.removeEventListener('keydown', editing.keydownHandler, { capture: true });
    editing.element.removeEventListener('blur', editing.blurHandler);
  }
}
