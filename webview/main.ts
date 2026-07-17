import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  autocompletion,
  completionStatus,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { tags } from '@lezer/highlight';
import { GFM } from '@lezer/markdown';
import './style.css';
import type { EditorTheme, HostToWebview, OutlineMode, WebviewToHost } from '../src/protocol';

declare function acquireVsCodeApi<State>(): {
  postMessage(message: WebviewToHost): void;
  getState(): State | undefined;
  setState(state: State): void;
};

type SavedState = { text: string; documentRevision: number; outlineCollapsed?: boolean };
type Heading = { label: string; level: number; offset: number };
type MdastNode = {
  type?: string;
  depth?: number;
  value?: string;
  children?: MdastNode[];
  position?: { start?: { offset?: number } };
};

const vscode = acquireVsCodeApi<SavedState>();
const root = required<HTMLElement>('#editor');
const status = required<HTMLElement>('#status');
const outline = required<HTMLElement>('#outline');
const outlineList = required<HTMLOListElement>('#outline-list');
const outlineEmpty = required<HTMLElement>('#outline-empty');
const outlineToggle = required<HTMLButtonElement>('#outline-toggle');
const savedState = vscode.getState();

let sourceText = savedState?.text ?? '';
let documentRevision = savedState?.documentRevision ?? 0;
let clientRevision = 0;
let syncDelay = 180;
let timer: number | undefined;
let editor: EditorView | undefined;
let applyingHostUpdate = false;
let wikiFiles: string[] = [];
let lastPointerDiagnostic: Record<string, unknown> | undefined;
let lastLinkRequest: Record<string, unknown> | undefined;
let lastHostLinkResult: Record<string, unknown> | undefined;
let localGeneration = 0;
const pendingEdits = new Map<number, number>();
let outlineCollapsed = savedState?.outlineCollapsed
  ?? window.matchMedia('(max-width: 700px)').matches;

const headingDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildHeadingDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildHeadingDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const inlineDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildInlineDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildInlineDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
]);

const linkDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildLinkDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildLinkDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

function buildHeadingDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber++) {
    const line = view.state.doc.line(lineNumber);
    const match = line.text.match(/^( {0,3})(#{1,6})(\s+)/);
    if (!match) continue;
    const level = match[2].length;
    const active = cursor >= line.from && cursor <= line.to;
    ranges.push(Decoration.line({
      attributes: { class: `cm-loommark-heading cm-loommark-h${level}${active ? ' cm-loommark-heading-active' : ''}` },
    }).range(line.from));
    if (!active) {
      const markerEnd = line.from + match[1].length + match[2].length + match[3].length;
      ranges.push(Decoration.replace({}).range(line.from, markerEnd));
    }
  }
  return Decoration.set(ranges, true);
}

function buildInlineDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  const source = view.state.doc.toString();
  const excluded = codeRanges(source);
  const patterns = [
    /\*\*(?=\S)(.+?\S)\*\*/g,
    /__(?=\S)(.+?\S)__/g,
    /~~(?=\S)(.+?\S)~~/g,
    /(?<!\*)\*(?!\*)(?=\S)(.+?\S)\*(?!\*)/g,
    /(?<!_)_(?!_)(?=\S)(.+?\S)_(?!_)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      if (containsPosition(excluded, from)) continue;
      const markerLength = match[0].startsWith('**') || match[0].startsWith('__')
        || match[0].startsWith('~~') ? 2 : 1;
      addHiddenSyntax(ranges, cursor, from, from + markerLength);
      addHiddenSyntax(ranges, cursor, to - markerLength, to);
    }
  }
  return Decoration.set(ranges, true);
}

function buildLinkDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  const source = view.state.doc.toString();
  const excluded = codeRanges(source);
  const wikiRanges: Array<{ from: number; to: number }> = [];
  const wikiPattern = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;

  for (const match of source.matchAll(wikiPattern)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    wikiRanges.push({ from, to });
    if (containsPosition(excluded, from)) continue;
    const target = match[1].trim();
    const pipe = match[0].indexOf('|');
    const labelFrom = pipe < 0 ? from + 2 : from + pipe + 1;
    const labelTo = to - 2;
    addHiddenSyntax(ranges, cursor, from, labelFrom);
    addHiddenSyntax(ranges, cursor, labelTo, to);
    ranges.push(Decoration.mark({
      attributes: {
        class: 'cm-loommark-link cm-loommark-wiki-link',
        'data-loommark-href': target,
        'data-loommark-wiki': 'true',
      },
    }).range(labelFrom, labelTo));
  }

  const linkPattern = /\[([^\]\n]+)\]\(([^\s)]+)(?:\s+["'][^"'\n]*["'])?\)/g;
  for (const match of source.matchAll(linkPattern)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      if (containsPosition(excluded, from)) continue;
      if (wikiRanges.some((range) => from < range.to && to > range.from)) continue;
      const labelFrom = from + 1;
      const labelTo = labelFrom + match[1].length;
      addHiddenSyntax(ranges, cursor, from, labelFrom);
      addHiddenSyntax(ranges, cursor, labelTo, to);
      ranges.push(Decoration.mark({
        attributes: { class: 'cm-loommark-link', 'data-loommark-href': match[2] },
      }).range(labelFrom, labelTo));
  }
  return Decoration.set(ranges, true);
}

function addHiddenSyntax(
  ranges: Range<Decoration>[],
  cursor: number,
  from: number,
  to: number,
): void {
  if (from < to && !(cursor >= from && cursor <= to)) {
    ranges.push(Decoration.replace({}).range(from, to));
  }
}

function containsPosition(ranges: Array<{ from: number; to: number }>, position: number): boolean {
  return ranges.some((range) => position >= range.from && position < range.to);
}

function codeRanges(source: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  const fencePattern = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gm;
  let fence: { marker: string; from: number } | undefined;
  for (const match of source.matchAll(fencePattern)) {
    const marker = match[1][0];
    const from = match.index ?? 0;
    if (!fence) fence = { marker, from };
    else if (fence.marker === marker) {
      ranges.push({ from: fence.from, to: from + match[0].length });
      fence = undefined;
    }
  }
  if (fence) ranges.push({ from: fence.from, to: source.length });
  for (const match of source.matchAll(/`+[^`\n]*`+/g)) {
    const from = match.index ?? 0;
    if (!containsPosition(ranges, from)) ranges.push({ from, to: from + match[0].length });
  }
  return ranges;
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing editor element: ${selector}`);
  return element;
}

function saveState(): void {
  vscode.setState({ text: sourceText, documentRevision, outlineCollapsed });
}

function scheduleSync(): void {
  window.clearTimeout(timer);
  if (applyingHostUpdate) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    clientRevision++;
    pendingEdits.set(clientRevision, localGeneration);
    vscode.postMessage({
      type: 'edit',
      text: sourceText,
      baseRevision: documentRevision,
      clientRevision,
    });
    status.textContent = 'Syncing...';
  }, syncDelay);
}

function createEditor(text: string): void {
  editor?.destroy();
  root.replaceChildren();
  editor = new EditorView({
    parent: root,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        markdown({ extensions: [GFM] }),
        autocompletion({ override: [wikiLinkCompletions] }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        headingDecorations,
        inlineDecorations,
        linkDecorations,
        syntaxHighlighting(markdownHighlightStyle),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || applyingHostUpdate) return;
          sourceText = update.state.doc.toString();
          localGeneration++;
          saveState();
          scheduleSync();
          refreshOutline();
        }),
      ],
    }),
  });
  refreshOutline();
}

root.addEventListener('mousedown', (event) => {
  const link = (event.target as HTMLElement).closest<HTMLElement>('[data-loommark-href]');
  lastPointerDiagnostic = {
    type: event.type,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    button: event.button,
    target: (event.target as HTMLElement).outerHTML?.slice(0, 500),
    matchedLink: link?.outerHTML.slice(0, 500),
  };
  if (!event.ctrlKey && !event.metaKey) return;
  if (!link) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  lastLinkRequest = {
    href: link.dataset.loommarkHref ?? '',
    wiki: link.dataset.loommarkWiki === 'true',
  };
  vscode.postMessage({
    type: 'openLink',
    href: link.dataset.loommarkHref ?? '',
    wiki: link.dataset.loommarkWiki === 'true',
  });
}, true);

function wikiLinkCompletions(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\[\[[^\]\n|]*/);
  if (!match) return null;
  return {
    from: match.from + 2,
    options: wikiFiles.map((target) => ({
      label: target,
      detail: 'Markdown file',
      type: 'file',
      apply(view, _completion, from, to) {
        const suffix = view.state.doc.sliceString(to, to + 2) === ']]' ? '' : ']]';
        view.dispatch({
          changes: { from, to, insert: target + suffix },
          selection: { anchor: from + target.length },
        });
      },
    })),
    validFor: /^[^\]\n|]*$/,
  };
}

function applyHostText(text: string): void {
  if (!editor) {
    sourceText = text;
    createEditor(text);
    return;
  }
  if (text === editor.state.doc.toString()) return;
  applyingHostUpdate = true;
  const selection = editor.state.selection;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
    selection: {
      anchor: Math.min(selection.main.anchor, text.length),
      head: Math.min(selection.main.head, text.length),
    },
  });
  sourceText = text;
  applyingHostUpdate = false;
  refreshOutline();
}

function headingsFromSource(source: string): Heading[] {
  const tree = fromMarkdown(source) as MdastNode;
  const headings: Heading[] = [];
  const text = (node: MdastNode): string => node.value ?? (node.children ?? []).map(text).join('');
  for (const node of tree.children ?? []) {
    if (node.type !== 'heading') continue;
    headings.push({
      label: text(node).trim() || `Untitled H${node.depth ?? 1}`,
      level: node.depth ?? 1,
      offset: node.position?.start?.offset ?? 0,
    });
  }
  return headings;
}

function revealHeading(heading: Heading): void {
  if (!editor) return;
  editor.dispatch({ selection: { anchor: heading.offset }, scrollIntoView: true });
  editor.focus();
}

function refreshOutline(): void {
  const headings = headingsFromSource(sourceText);
  outlineList.replaceChildren();
  headings.forEach((heading) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline-item';
    button.style.setProperty('--outline-level', String(heading.level - 1));
    button.textContent = heading.label;
    button.addEventListener('click', () => revealHeading(heading));
    item.append(button);
    outlineList.append(item);
  });
  outlineEmpty.hidden = headings.length > 0;
}

function setOutlineCollapsed(collapsed: boolean): void {
  outlineCollapsed = collapsed;
  outline.classList.toggle('collapsed', collapsed);
  document.body.classList.toggle('outline-collapsed', collapsed);
  outlineToggle.ariaExpanded = String(!collapsed);
  outlineToggle.ariaLabel = collapsed ? 'Expand outline' : 'Collapse outline';
  outlineToggle.title = collapsed ? 'Expand outline' : 'Collapse outline';
  saveState();
}

function applyConfiguration(nextSyncDelay: number, theme: EditorTheme, outlineMode: OutlineMode): void {
  syncDelay = nextSyncDelay;
  document.body.dataset.loommarkTheme = theme;
  document.body.classList.toggle('editor-outline-disabled', outlineMode === 'explorer' || outlineMode === 'off');
}

outlineToggle.addEventListener('click', () => setOutlineCollapsed(!outlineCollapsed));
setOutlineCollapsed(outlineCollapsed);

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  if (message.type === 'init') {
    sourceText = message.text;
    documentRevision = message.revision;
    wikiFiles = message.wikiFiles;
    applyConfiguration(message.syncDelay, message.theme, message.outline);
    createEditor(message.text);
    status.textContent = '';
    saveState();
  } else if (message.type === 'configuration') {
    applyConfiguration(message.syncDelay, message.theme, message.outline);
  } else if (message.type === 'ack') {
    documentRevision = message.documentRevision;
    const sentGeneration = pendingEdits.get(message.clientRevision);
    pendingEdits.delete(message.clientRevision);
    if (sentGeneration === localGeneration && message.text !== sourceText) {
      applyHostText(message.text);
    }
    status.textContent = '';
    saveState();
  } else if (message.type === 'documentChanged') {
    if (timer !== undefined || pendingEdits.size > 0) return;
    window.clearTimeout(timer);
    timer = undefined;
    documentRevision = message.documentRevision;
    applyHostText(message.text);
    status.textContent = '';
    saveState();
  } else if (message.type === 'revealHeading') {
    const heading = headingsFromSource(sourceText)[message.ordinal];
    if (heading) revealHeading(heading);
  } else if (message.type === 'wikiFilesChanged') {
    wikiFiles = message.wikiFiles;
  } else if (message.type === 'linkOpenResult') {
    lastHostLinkResult = { ...message, receivedAt: new Date().toISOString() };
  } else if (message.type === 'requestDiagnostics') {
    const lines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).map((line) => ({
      text: line.textContent,
      html: line.innerHTML,
    }));
    const report = JSON.stringify({
      documentRevision,
      localGeneration,
      pendingEdits: pendingEdits.size,
      wikiFileCount: wikiFiles.length,
      wikiFiles: wikiFiles.slice(0, 50),
      completionStatus: editor ? completionStatus(editor.state) : null,
      activeElement: document.activeElement?.className || document.activeElement?.tagName,
      sourceMatches: {
        wiki: Array.from(sourceText.matchAll(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g))
          .map((match) => match[0]),
        markdown: Array.from(sourceText.matchAll(/\[([^\]\n]+)\]\(([^\s)]+)(?:\s+["'][^"'\n]*["'])?\)/g))
          .map((match) => match[0]),
      },
      linkElements: Array.from(document.querySelectorAll<HTMLElement>('[data-loommark-href]'))
        .map((element) => ({
          text: element.textContent,
          href: element.dataset.loommarkHref,
          wiki: element.dataset.loommarkWiki,
          html: element.outerHTML,
        })),
      lastPointerDiagnostic,
      lastLinkRequest,
      lastHostLinkResult,
      editorLoaded: Boolean(editor),
      editorText: editor?.state.doc.toString(),
      classes: Array.from(document.querySelectorAll<HTMLElement>('[class*="loommark"]'))
        .map((element) => element.className),
      lines,
    }, null, 2);
    vscode.postMessage({ type: 'diagnostics', report });
  }
});

window.addEventListener('beforeunload', () => {
  window.clearTimeout(timer);
  editor?.destroy();
});
vscode.postMessage({ type: 'ready' });
