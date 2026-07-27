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
const root = document.getElementById('loommark-root');
if (!root) throw new Error('Missing #loommark-root element');

let editor: LoomMarkEditor | undefined;
let nextPasteRequestId = 1;
const pendingPasteRequests = new Map<number, (result: PasteImageResult) => void>();
let pendingLinkRequest: ((result: LinkOpenResult) => void) | undefined;

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  const message = event.data;
  if (message.type === 'init') {
    editor?.destroy();
    editor = createLoomMarkEditor(root, {
      ...message,
      documentRevision: message.revision,
      initialOutlineCollapsed: savedState?.outlineCollapsed,
      initialCursor: savedState?.cursor,
      onSync(text, baseRevision, clientRevision) {
        vscode.postMessage({ type: 'edit', text, baseRevision, clientRevision });
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
  } else if (message.type === 'configuration') {
    editor?.updateConfiguration(message);
  } else if (message.type === 'ack') {
    editor?.acknowledgeSync(message.clientRevision, message.documentRevision, message.text);
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

vscode.postMessage({ type: 'ready' });
