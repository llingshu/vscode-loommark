import { Crepe } from '@milkdown/crepe';
import { replaceAll } from '@milkdown/kit/utils';
import '@milkdown/crepe/theme/common/style.css';
import './style.css';
import type { HostToWebview, OutlineMode, EditorTheme, WebviewToHost } from '../src/protocol';

declare function acquireVsCodeApi<State>(): {
  postMessage(message: WebviewToHost): void;
  getState(): State | undefined;
  setState(state: State): void;
};

type SavedState = { text: string; documentRevision: number; outlineCollapsed?: boolean };
const vscode = acquireVsCodeApi<SavedState>();
const editorElement = document.querySelector<HTMLElement>('#editor');
const statusElement = document.querySelector<HTMLElement>('#status');
const outlineElement = document.querySelector<HTMLElement>('#outline');
const outlineListElement = document.querySelector<HTMLOListElement>('#outline-list');
const outlineEmptyElement = document.querySelector<HTMLElement>('#outline-empty');
const outlineToggleElement = document.querySelector<HTMLButtonElement>('#outline-toggle');
if (!editorElement || !statusElement || !outlineElement || !outlineListElement
  || !outlineEmptyElement || !outlineToggleElement) throw new Error('Editor host is missing');
const root = editorElement;
const status = statusElement;
const outline = outlineElement;
const outlineList = outlineListElement;
const outlineEmpty = outlineEmptyElement;
const outlineToggle = outlineToggleElement;
const savedState = vscode.getState();

let crepe: Crepe | undefined;
let lastText = savedState?.text ?? '';
let documentRevision = savedState?.documentRevision ?? 0;
let clientRevision = 0;
let syncDelay = 180;
let timer: number | undefined;
let composing = false;
let applyingHostUpdate = false;
let outlineCollapsed = savedState?.outlineCollapsed
  ?? window.matchMedia('(max-width: 700px)').matches;
let outlineFrame: number | undefined;
let activeFrame: number | undefined;
let outlineEntries: Array<{ heading: HTMLHeadingElement; button: HTMLButtonElement }> = [];

function saveState(): void {
  vscode.setState({ text: lastText, documentRevision, outlineCollapsed });
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

function updateActiveOutline(): void {
  if (!outlineEntries.length) return;
  let active = outlineEntries[0];
  for (const entry of outlineEntries) {
    if (entry.heading.getBoundingClientRect().top > 96) break;
    active = entry;
  }
  for (const entry of outlineEntries) {
    const selected = entry === active;
    entry.button.classList.toggle('active', selected);
    if (selected) entry.button.setAttribute('aria-current', 'location');
    else entry.button.removeAttribute('aria-current');
  }
}

function refreshOutline(): void {
  const headings = Array.from(root.querySelectorAll<HTMLHeadingElement>(
    '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6',
  ));
  outlineList.replaceChildren();
  outlineEntries = headings.map((heading) => {
    const level = Number(heading.tagName.slice(1));
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline-item';
    button.style.setProperty('--outline-level', String(level - 1));
    button.textContent = heading.textContent?.trim() || `Untitled H${level}`;
    button.title = button.textContent;
    button.addEventListener('click', () => {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    item.append(button);
    outlineList.append(item);
    return { heading, button };
  });
  outlineEmpty.hidden = headings.length > 0;
  updateActiveOutline();
}

function queueOutlineRefresh(): void {
  if (outlineFrame !== undefined) window.cancelAnimationFrame(outlineFrame);
  outlineFrame = window.requestAnimationFrame(refreshOutline);
}

function queueActiveOutlineUpdate(): void {
  if (activeFrame !== undefined) return;
  activeFrame = window.requestAnimationFrame(() => {
    activeFrame = undefined;
    updateActiveOutline();
  });
}

function applyConfiguration(nextSyncDelay: number, theme: EditorTheme, outlineMode: OutlineMode): void {
  syncDelay = nextSyncDelay;
  document.body.dataset.loommarkTheme = theme;
  document.body.classList.toggle(
    'editor-outline-disabled',
    outlineMode === 'explorer' || outlineMode === 'off',
  );
}

root.addEventListener('compositionstart', () => { composing = true; });
root.addEventListener('compositionend', () => {
  composing = false;
  schedule(lastText);
});
outlineToggle.addEventListener('click', () => setOutlineCollapsed(!outlineCollapsed));
window.addEventListener('scroll', queueActiveOutlineUpdate, { passive: true });
setOutlineCollapsed(outlineCollapsed);

function schedule(text: string): void {
  window.clearTimeout(timer);
  if (composing || applyingHostUpdate) return;
  timer = window.setTimeout(() => {
    clientRevision++;
    vscode.postMessage({
      type: 'edit',
      text,
      baseRevision: documentRevision,
      clientRevision,
    });
    status.textContent = 'Syncing...';
  }, syncDelay);
}

async function createEditor(text: string): Promise<void> {
  lastText = text;
  crepe = new Crepe({ root, defaultValue: text });
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, markdown) => {
      if (applyingHostUpdate || markdown === lastText) return;
      lastText = markdown;
      saveState();
      schedule(markdown);
      queueOutlineRefresh();
    });
  });
  await crepe.create();
  queueOutlineRefresh();
  status.textContent = '';
}

async function applyHostText(text: string): Promise<void> {
  if (!crepe || text === lastText) return;
  applyingHostUpdate = true;
  window.clearTimeout(timer);
  lastText = text;
  crepe.editor.action(replaceAll(text));
  applyingHostUpdate = false;
  saveState();
  queueOutlineRefresh();
}

window.addEventListener('message', async (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  if (message.type === 'init') {
    documentRevision = message.revision;
    applyConfiguration(message.syncDelay, message.theme, message.outline);
    if (!crepe) await createEditor(message.text);
    else await applyHostText(message.text);
  } else if (message.type === 'configuration') {
    applyConfiguration(message.syncDelay, message.theme, message.outline);
  } else if (message.type === 'ack') {
    documentRevision = message.documentRevision;
    status.textContent = '';
    saveState();
  } else if (message.type === 'documentChanged') {
    documentRevision = message.documentRevision;
    await applyHostText(message.text);
    status.textContent = '';
  } else if (message.type === 'revealHeading') {
    const entry = outlineEntries[message.ordinal];
    entry?.heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

window.addEventListener('beforeunload', () => window.clearTimeout(timer));
vscode.postMessage({ type: 'ready' });
