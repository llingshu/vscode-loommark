import { EditorView, WidgetType } from '@codemirror/view';
import type { FencedCodeRange, ImageRange, TableCell, TableRange } from './markdown-ranges';

export const codeLanguages = [
  '', 'bash', 'shell', 'powershell', 'javascript', 'typescript', 'json', 'python',
  'html', 'css', 'scss', 'sql', 'yaml', 'markdown', 'java', 'c', 'cpp', 'rust', 'go',
];

export function isTerminalLanguage(language: string): boolean {
  return ['bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'pwsh', 'console', 'terminal'].includes(
    language.toLowerCase(),
  );
}

export class CodeToolbarWidget extends WidgetType {
  constructor(private readonly block: FencedCodeRange) {
    super();
  }

  eq(other: CodeToolbarWidget): boolean {
    return this.block.openFrom === other.block.openFrom
      && this.block.language === other.block.language
      && this.block.code === other.block.code;
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
      option.textContent = language || 'Plain text';
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
    return toolbar;
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
