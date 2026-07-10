export type HostToWebview =
  | { type: 'init'; text: string; revision: number; syncDelay: number; theme: EditorTheme; outline: OutlineMode }
  | { type: 'configuration'; syncDelay: number; theme: EditorTheme; outline: OutlineMode }
  | { type: 'ack'; clientRevision: number; documentRevision: number }
  | { type: 'documentChanged'; text: string; documentRevision: number }
  | { type: 'revealHeading'; ordinal: number };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'edit'; text: string; baseRevision: number; clientRevision: number };

export type EditorTheme = 'vscode' | 'crepe' | 'frame' | 'nord';
export type OutlineMode = 'both' | 'editor' | 'explorer' | 'off';

export function isWebviewMessage(value: unknown): value is WebviewToHost {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'ready') return true;
  return message.type === 'edit'
    && typeof message.text === 'string'
    && Number.isInteger(message.baseRevision)
    && Number.isInteger(message.clientRevision);
}
