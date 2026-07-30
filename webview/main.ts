import { createLoomMarkEditor, type LoomMarkEditor } from '@llingshu/loommark-core';
import '@llingshu/loommark-core/style.css';
import './vscode-theme.css';
import './annotation.css';
import { annotationExtension } from './annotation-extension';
import type { HostToWebview, WebviewToHost } from '../src/protocol';

declare function acquireVsCodeApi<State>(): {
  postMessage(message: WebviewToHost): void;
  getState(): State | undefined;
  setState(state: State): void;
};

type SavedState = { text: string; documentRevision: number; outlineCollapsed?: boolean; cursor?: number };
type LinkOpenResult = { status: 'opened' | 'error'; resolvedUri?: string; error?: string };
type PasteImageResult = { relativePath?: string; error?: string };

const vscode = acquireVsCodeApi<SavedState>();
const savedState = vscode.getState();
const root: HTMLElement = (() => {
  const candidate = document.getElementById('loommark-root');
  if (!candidate) throw new Error('Missing #loommark-root element');
  return candidate;
})();

let editor: LoomMarkEditor | undefined;
let nextPasteRequestId = 1;
const pendingPasteRequests = new Map<number, (result: PasteImageResult) => void>();
let pendingLinkRequest: ((result: LinkOpenResult) => void) | undefined;
let initialized = false;
let connected = false;
let initialConnectionTimeout: number | undefined;
const syncTimeouts = new Map<number, number>();
const connectionWarningMessage = document.createElement('p');
const defaultConnectionWarning = 'LoomMark lost its connection to VS Code. The text visible here may exist only in this editor and is not confirmed on disk.';

const connectionWarning = document.createElement('section');
connectionWarning.className = 'loommark-connection-warning';
connectionWarning.hidden = true;
connectionWarning.setAttribute('role', 'alert');
connectionWarning.tabIndex = -1;
connectionWarning.innerHTML = `
  <strong>Markdown has not been saved</strong>
  <div class="loommark-connection-warning-actions">
    <button type="button" data-loommark-copy-recovery>Copy recovery text</button>
    <button type="button" data-loommark-retry-connection>Retry connection</button>
  </div>
`;
connectionWarningMessage.textContent = defaultConnectionWarning;
connectionWarning.querySelector('.loommark-connection-warning-actions')?.before(connectionWarningMessage);
root.append(connectionWarning);

function clearInitialConnectionTimeout(): void {
  if (initialConnectionTimeout !== undefined) {
    window.clearTimeout(initialConnectionTimeout);
    initialConnectionTimeout = undefined;
  }
}

function clearSyncTimeout(clientRevision: number): void {
  const timeout = syncTimeouts.get(clientRevision);
  if (timeout !== undefined) window.clearTimeout(timeout);
  syncTimeouts.delete(clientRevision);
}

function clearAllSyncTimeouts(): void {
  for (const clientRevision of syncTimeouts.keys()) clearSyncTimeout(clientRevision);
}

function requestInitialization(): void {
  vscode.postMessage({ type: 'ready' });
}

function showConnectionWarning(detail = defaultConnectionWarning): void {
  connected = false;
  root.classList.add('loommark-sync-offline');
  connectionWarningMessage.textContent = detail;
  connectionWarning.hidden = false;
  connectionWarning.focus();
}

function hideConnectionWarning(): void {
  connected = true;
  root.classList.remove('loommark-sync-offline');
  connectionWarning.hidden = true;
}

connectionWarning.querySelector<HTMLButtonElement>('[data-loommark-copy-recovery]')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(editor?.getText() ?? savedState?.text ?? '');
  } catch {
    // The visible warning remains; a browser clipboard denial must not look like a successful copy.
    return;
  }
});
connectionWarning.querySelector<HTMLButtonElement>('[data-loommark-retry-connection]')?.addEventListener('click', () => {
  requestInitialization();
});

// Do not leave a newly reloaded Webview as an apparently-editable blank surface while waiting for
// its extension host to attach.
initialConnectionTimeout = window.setTimeout(() => {
  if (!initialized) showConnectionWarning();
}, 8000);

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  if (message.type === 'init') {
    clearInitialConnectionTimeout();
    clearAllSyncTimeouts();
    initialized = true;
    editor?.destroy();
    editor = createLoomMarkEditor(root, {
      ...message,
      documentRevision: message.revision,
      initialOutlineCollapsed: savedState?.outlineCollapsed,
      initialCursor: savedState?.cursor,
      onSync(text, baseRevision, clientRevision) {
        vscode.postMessage({ type: 'edit', text, baseRevision, clientRevision });
        clearSyncTimeout(clientRevision);
        syncTimeouts.set(clientRevision, window.setTimeout(() => {
          syncTimeouts.delete(clientRevision);
          showConnectionWarning();
        }, 8000));
      },
      onPasteImage(data, mimeType) {
        return new Promise((resolve) => {
          const requestId = nextPasteRequestId++;
          pendingPasteRequests.set(requestId, resolve);
          vscode.postMessage({ type: 'pasteImage', requestId, data, mimeType });
        });
      },
      onOpenLink(href, wiki) {
        return new Promise((resolve) => {
          pendingLinkRequest = resolve;
          vscode.postMessage({ type: 'openLink', href, wiki });
        });
      },
      onStateChange(state) {
        vscode.setState(state);
      },
      extensions: [annotationExtension()],
    });
    root.append(connectionWarning);
    hideConnectionWarning();
  } else if (message.type === 'configuration') {
    editor?.updateConfiguration(message);
  } else if (message.type === 'ack') {
    clearSyncTimeout(message.clientRevision);
    hideConnectionWarning();
    editor?.acknowledgeSync(message.clientRevision, message.documentRevision, message.text);
  } else if (message.type === 'syncError') {
    clearSyncTimeout(message.clientRevision);
    showConnectionWarning(`VS Code rejected this edit: ${message.error} The visible text is not confirmed on disk.`);
  } else if (message.type === 'documentChanged') {
    editor?.setText(message.text, message.documentRevision);
  } else if (message.type === 'revealHeading') {
    editor?.revealHeadingByOrdinal(message.ordinal);
  } else if (message.type === 'wikiFilesChanged') {
    editor?.setWikiFiles(message.wikiFiles);
  } else if (message.type === 'linkOpenResult') {
    pendingLinkRequest?.(message);
    pendingLinkRequest = undefined;
  } else if (message.type === 'imagePasteResult') {
    const resolve = pendingPasteRequests.get(message.requestId);
    pendingPasteRequests.delete(message.requestId);
    resolve?.(message);
  } else if (message.type === 'requestDiagnostics') {
    const report = editor ? JSON.stringify(editor.getDiagnosticsReport(), null, 2) : '{}';
    vscode.postMessage({ type: 'diagnostics', report });
  }
});

window.addEventListener('focus', () => {
  if (!connected) requestInitialization();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !connected) requestInitialization();
});

requestInitialization();
