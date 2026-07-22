export type EditorConfiguration = {
  syncDelay: number;
  theme: EditorTheme;
  outline: OutlineMode;
  table: TableMode;
  tableStyle: TableStyle;
  orderedListStyle: OrderedListStyle;
  keyboardEditing: boolean;
  listGuides: boolean;
  cardMode: CardMode;
  cardColors: string[];
};

export type HostToWebview =
  | ({ type: 'init'; text: string; revision: number; resourceBase: string; wikiFiles: string[] } & EditorConfiguration)
  | ({ type: 'configuration' } & EditorConfiguration)
  | { type: 'ack'; clientRevision: number; documentRevision: number; text: string }
  | { type: 'documentChanged'; text: string; documentRevision: number }
  | { type: 'revealHeading'; ordinal: number }
  | { type: 'wikiFilesChanged'; wikiFiles: string[] }
  | { type: 'linkOpenResult'; href: string; status: 'received' | 'opened' | 'error'; resolvedUri?: string; error?: string }
  | { type: 'requestDiagnostics' };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'edit'; text: string; baseRevision: number; clientRevision: number }
  | { type: 'openLink'; href: string; wiki?: boolean }
  | { type: 'diagnostics'; report: string };

export type EditorTheme = 'vscode' | 'crepe' | 'frame' | 'nord';
export type OutlineMode = 'both' | 'editor' | 'explorer' | 'off';
export type TableMode = 'rich' | 'source';
export type TableStyle = 'grid' | 'ruled';
export type OrderedListStyle = 'decimal' | 'cycle';
// off: no heading visualization. tint: soft background wash only, no borders. accent: a colored
// left border bar per level plus a faint tint. card: a bordered box, rounded at the outermost
// level only (see docs/EDITOR_TECHNOLOGY.md for why deeper levels can't independently round).
export type CardMode = 'off' | 'tint' | 'accent' | 'card';
export const CARD_MODE_ORDER: readonly CardMode[] = ['off', 'tint', 'accent', 'card'];

export function isWebviewMessage(value: unknown): value is WebviewToHost {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'ready') return true;
  if (message.type === 'diagnostics') return typeof message.report === 'string';
  return (message.type === 'edit'
    && typeof message.text === 'string'
    && Number.isInteger(message.baseRevision)
    && Number.isInteger(message.clientRevision)
    ) || (message.type === 'openLink'
      && typeof message.href === 'string'
      && (message.wiki === undefined || typeof message.wiki === 'boolean'));
}
