import type { EditorConfiguration } from '@llingshu/loommark-core/pure';

// Imports from the /pure subpath, not the bare package — these types and CARD_MODE_ORDER (an
// actual runtime value, not just a type) have zero CodeMirror/DOM dependency, and this module is
// shared by both extension.ts (Node.js) and webview/main.ts (browser); resolving through the
// bare package here would pull the whole CodeMirror-dependent bundle into the Node.js side too.
export type {
  BackgroundConfiguration,
  CardImageConfiguration,
  CardMode,
  EditorConfiguration,
  EditorTheme,
  OrderedListStyle,
  OutlineMode,
  TableMode,
  TableStyle,
} from '@llingshu/loommark-core/pure';
export { CARD_MODE_ORDER } from '@llingshu/loommark-core/pure';

export type HostToWebview =
  | ({ type: 'init'; text: string; revision: number; resourceBase: string; wikiFiles: string[] } & EditorConfiguration)
  | ({ type: 'configuration' } & EditorConfiguration)
  | { type: 'ack'; clientRevision: number; documentRevision: number; text: string }
  | { type: 'syncError'; clientRevision: number; error: string }
  | { type: 'documentChanged'; text: string; documentRevision: number }
  | { type: 'revealHeading'; ordinal: number }
  | { type: 'wikiFilesChanged'; wikiFiles: string[] }
  | { type: 'linkOpenResult'; href: string; status: 'opened' | 'error'; resolvedUri?: string; error?: string }
  | { type: 'requestDiagnostics' }
  | { type: 'imagePasteResult'; requestId: number; relativePath?: string; error?: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'edit'; text: string; baseRevision: number; clientRevision: number }
  | { type: 'openLink'; href: string; wiki?: boolean }
  | { type: 'diagnostics'; report: string }
  | { type: 'pasteImage'; requestId: number; data: string; mimeType: string };

export function isWebviewMessage(value: unknown): value is WebviewToHost {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'ready') return true;
  if (message.type === 'diagnostics') return typeof message.report === 'string';
  if (message.type === 'pasteImage') {
    return Number.isInteger(message.requestId)
      && typeof message.data === 'string'
      && typeof message.mimeType === 'string';
  }
  return (message.type === 'edit'
    && typeof message.text === 'string'
    && Number.isInteger(message.baseRevision)
    && Number.isInteger(message.clientRevision)
    ) || (message.type === 'openLink'
      && typeof message.href === 'string'
      && (message.wiki === undefined || typeof message.wiki === 'boolean'));
}
