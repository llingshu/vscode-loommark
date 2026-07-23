import * as vscode from 'vscode';
import * as path from 'node:path';
import { markdownOutline, type OutlineNode } from './outline';
import type { BackgroundConfiguration, CardImageConfiguration, EditorConfiguration, HostToWebview, OutlineMode, EditorTheme, TableMode, TableStyle, OrderedListStyle, CardMode } from './protocol';
import { CARD_MODE_ORDER, isWebviewMessage } from './protocol';
import { singleSplice } from './text';

const viewType = 'loommark.editor';

// Shipped default for loommark.cardBackgroundColors/cardBorderColors, matching package.json and
// webview/main.ts's own copy (kept in sync manually; there is no shared runtime module between
// the two bundles for a six-entry constant).
const DEFAULT_CARD_COLORS = ['#7c3aed', '#2563eb', '#168a72', '#b46a08', '#be3455', '#087f8c'];

export function activate(context: vscode.ExtensionContext): void {
  const provider = new LoomMarkProvider(context);
  const outlineProvider = new MarkdownOutlineTree();
  const syncAssociation = () => syncDefaultEditorAssociation().catch((error: unknown) => {
    console.error('LoomMark could not update the default editor association.', error);
  });
  syncAssociation();
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('loommark.openSource', async () => {
      const uri = provider.activeDocumentUri;
      if (uri) await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),
    vscode.commands.registerCommand('loommark.focusOutline', async () => {
      await vscode.commands.executeCommand('workbench.view.explorer');
      await vscode.commands.executeCommand('loommark.outline.focus');
    }),
    vscode.commands.registerCommand('loommark.copyDiagnostics', async () => {
      if (!provider.requestDiagnostics()) {
        void vscode.window.showWarningMessage('Open a Markdown file in LoomMark first.');
      }
    }),
    vscode.commands.registerCommand('loommark.toggleCardMode', async () => {
      const configuration = vscode.workspace.getConfiguration('loommark');
      const current = configuration.get<string>('cardMode', 'card');
      const index = CARD_MODE_ORDER.indexOf(current as CardMode);
      const next = CARD_MODE_ORDER[(index < 0 ? 0 : index + 1) % CARD_MODE_ORDER.length];
      await configuration.update('cardMode', next, vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage(`LoomMark: heading style — ${next}`, 2500);
    }),
    vscode.window.createTreeView('loommark.outline', {
      treeDataProvider: outlineProvider,
      showCollapseAll: true,
    }),
    vscode.commands.registerCommand('loommark.revealHeading', async (ordinal: number) => {
      await provider.revealHeading(ordinal);
    }),
    provider.onDidChangeActiveDocument((document) => outlineProvider.setDocument(document)),
    vscode.workspace.onDidChangeTextDocument((event) => outlineProvider.updateDocument(event.document)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('loommark.openByDefault')) syncAssociation();
    }),
    provider,
    outlineProvider,
  );
}

async function syncDefaultEditorAssociation(): Promise<void> {
  const enabled = vscode.workspace.getConfiguration('loommark').get('openByDefault', true);
  const workbench = vscode.workspace.getConfiguration('workbench');
  const current = workbench.inspect<Record<string, string>>('editorAssociations')?.globalValue ?? {};
  const next = { ...current };
  let changed = false;

  for (const pattern of ['*.md', '*.markdown']) {
    if (enabled && next[pattern] !== viewType) {
      next[pattern] = viewType;
      changed = true;
    } else if (!enabled && next[pattern] === viewType) {
      delete next[pattern];
      changed = true;
    }
  }

  if (changed) {
    await workbench.update('editorAssociations', next, vscode.ConfigurationTarget.Global);
  }
}

function editorConfiguration(
  background: BackgroundConfiguration,
  cardImage: CardImageConfiguration,
): EditorConfiguration {
  const configuration = vscode.workspace.getConfiguration('loommark');
  const configuredTheme = configuration.get<string>('theme', 'vscode');
  const theme: EditorTheme = ['crepe', 'frame', 'nord'].includes(configuredTheme)
    ? configuredTheme as EditorTheme
    : 'vscode';
  const configuredOutline = configuration.get<string>('outline', 'both');
  const outline: OutlineMode = ['editor', 'explorer', 'off'].includes(configuredOutline)
    ? configuredOutline as OutlineMode
    : 'both';
  const table: TableMode = configuration.get<string>('table', 'rich') === 'source' ? 'source' : 'rich';
  const tableStyle: TableStyle = configuration.get<string>('tableStyle', 'grid') === 'ruled' ? 'ruled' : 'grid';
  const orderedListStyle: OrderedListStyle = configuration.get<string>('orderedListStyle', 'cycle') === 'decimal'
    ? 'decimal'
    : 'cycle';
  const configuredCardMode = configuration.get<string>('cardMode', 'card');
  const cardMode: CardMode = CARD_MODE_ORDER.includes(configuredCardMode as CardMode)
    ? configuredCardMode as CardMode
    : 'card';
  return {
    syncDelay: configuration.get('syncDelay', 180),
    theme,
    outline,
    table,
    tableStyle,
    orderedListStyle,
    keyboardEditing: configuration.get('keyboardEditing', false),
    listGuides: configuration.get('listGuides', true),
    cardMode,
    cardBackgroundColors: configuration.get<string[]>('cardBackgroundColors', DEFAULT_CARD_COLORS),
    cardBorderColors: configuration.get<string[]>('cardBorderColors', DEFAULT_CARD_COLORS),
    cardBackgroundStrength: clampSetting(configuration.get('cardBackgroundStrength', 0.06), 0, 0.3),
    cardBorderStrength: clampSetting(configuration.get('cardBorderStrength', 0.52), 0.15, 1),
    background,
    cardImage,
  };
}

const imageExtensionPattern = /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i;

function clampSetting(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

type ConfiguredImageSource = { kind: 'remote'; url: string } | { kind: 'local'; uri: vscode.Uri };

// Deliberately narrower than a generic "scheme://" test: the already-supported `file://` prefix
// (stripped below and resolved as a local path) also matches that shape, and the Webview CSP only
// permits https:/data: to load in the first place, so recognizing any other scheme as "remote"
// would just produce a silently-broken image. A bare "C:" drive letter never has a second slash,
// so Windows paths (documented as a supported loommark.background.path/cardImage.path form) are
// never misread as remote either.
const remoteUrlPattern = /^https?:\/\//i;

function configuredImagePath(setting: 'background.path' | 'cardImage.path'): ConfiguredImageSource | undefined {
  const configuration = vscode.workspace.getConfiguration('loommark');
  const configured = configuration.get<string>(setting, '').trim()
    || (setting === 'cardImage.path' ? configuration.get<string>('background.path', '').trim() : '');
  if (!configured) return undefined;
  if (remoteUrlPattern.test(configured)) return { kind: 'remote', url: configured };
  return { kind: 'local', uri: vscode.Uri.file(configured.replace(/^file:(?:\/\/)?/i, '')) };
}

async function backgroundResourceRoots(): Promise<vscode.Uri[]> {
  const roots: vscode.Uri[] = [];
  for (const source of [configuredImagePath('background.path'), configuredImagePath('cardImage.path')]) {
    if (!source || source.kind === 'remote') continue;
    try {
      const stat = await vscode.workspace.fs.stat(source.uri);
      const root = stat.type & vscode.FileType.Directory ? source.uri : vscode.Uri.joinPath(source.uri, '..');
      if (!roots.some((entry) => entry.toString() === root.toString())) roots.push(root);
    } catch {
      // The resolver reports the actionable error after the Webview is initialized.
    }
  }
  return roots;
}

function stableIndex(seed: string, count: number): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

async function resolvedBackground(
  webview: vscode.Webview,
  document: vscode.TextDocument,
): Promise<BackgroundConfiguration> {
  const configuration = vscode.workspace.getConfiguration('loommark');
  const enabled = configuration.get('background.enabled', false);
  const result: BackgroundConfiguration = {
    enabled,
    opacity: clampSetting(configuration.get('background.opacity', 0.72), 0, 1),
    blur: clampSetting(configuration.get('background.blur', 14), 0, 80),
    saturation: clampSetting(configuration.get('background.saturation', 0.7), 0, 2),
    overlay: clampSetting(configuration.get('background.overlay', 0.42), 0, 1),
    status: enabled ? 'missing' : 'disabled',
  };
  const source = configuredImagePath('background.path');
  if (!enabled || !source) return result;
  if (source.kind === 'remote') {
    // A remote URL is always exactly one image; loommark.background.selection (which rotates
    // through a local directory's entries) has nothing to select between here.
    result.imageUri = source.url;
    result.status = 'loaded';
    result.detail = source.url;
    return result;
  }
  const localSource = source.uri;
  try {
    const stat = await vscode.workspace.fs.stat(localSource);
    let selected = localSource;
    if (stat.type & vscode.FileType.Directory) {
      const entries = (await vscode.workspace.fs.readDirectory(localSource))
        .filter(([name, type]) => type & vscode.FileType.File && imageExtensionPattern.test(name))
        .map(([name]) => name)
        .sort((left, right) => left.localeCompare(right));
      if (!entries.length) return { ...result, status: 'empty', detail: localSource.fsPath };
      const selection = configuration.get<string>('background.selection', 'daily');
      let index = 0;
      if (selection === 'onOpen') index = Math.floor(Math.random() * entries.length);
      else if (selection === 'daily') index = stableIndex(new Date().toISOString().slice(0, 10), entries.length);
      else if (selection === 'perDocument') index = stableIndex(document.uri.toString(), entries.length);
      selected = vscode.Uri.joinPath(localSource, entries[index]);
    } else if (!imageExtensionPattern.test(localSource.path)) {
      return { ...result, status: 'error', detail: `Unsupported image: ${localSource.fsPath}` };
    }
    result.imageUri = webview.asWebviewUri(selected).toString();
    result.status = 'loaded';
    result.detail = selected.fsPath;
  } catch (error: unknown) {
    console.warn('LoomMark could not load the configured background.', error);
    result.status = 'error';
    const detail = String(error);
    const blockedUncHost = detail.match(/UNC host '([^']+)' access is not allowed/i)?.[1];
    const allowedUncHosts = vscode.workspace
      .getConfiguration('security')
      .get<string[]>('allowedUNCHosts', []);
    result.detail = blockedUncHost
      ? `${detail} Add ${JSON.stringify(blockedUncHost)} to the VS Code Application setting security.allowedUNCHosts. Current extension host value: ${JSON.stringify(allowedUncHosts)}.`
      : detail;
  }
  return result;
}

async function resolvedCardImage(webview: vscode.Webview): Promise<CardImageConfiguration> {
  const configuration = vscode.workspace.getConfiguration('loommark');
  const enabled = configuration.get('cardImage.enabled', false);
  const result: CardImageConfiguration = {
    enabled,
    imageUris: [],
    opacity: clampSetting(configuration.get('cardImage.opacity', 0.72), 0, 1),
    blur: clampSetting(configuration.get('cardImage.blur', 4), 0, 40),
    saturation: clampSetting(configuration.get('cardImage.saturation', 0.75), 0, 2),
    overlay: clampSetting(configuration.get('cardImage.overlay', 0.18), 0, 1),
    status: enabled ? 'missing' : 'disabled',
  };
  const source = configuredImagePath('cardImage.path');
  if (!enabled || !source) return result;
  if (source.kind === 'remote') {
    // A single-entry array: cardImageIndex (webview/main.ts) picks an index into imageUris per
    // heading, but with exactly one remote URL configured every heading section gets that image.
    result.imageUris = [source.url];
    result.status = 'loaded';
    result.detail = source.url;
    return result;
  }
  const localSource = source.uri;
  try {
    const stat = await vscode.workspace.fs.stat(localSource);
    let images: vscode.Uri[];
    if (stat.type & vscode.FileType.Directory) {
      images = (await vscode.workspace.fs.readDirectory(localSource))
        .filter(([name, type]) => type & vscode.FileType.File && imageExtensionPattern.test(name))
        .map(([name]) => vscode.Uri.joinPath(localSource, name))
        .sort((left, right) => left.path.localeCompare(right.path));
    } else {
      images = imageExtensionPattern.test(localSource.path) ? [localSource] : [];
    }
    if (!images.length) return { ...result, status: 'empty', detail: localSource.fsPath };
    result.imageUris = images.map((image) => webview.asWebviewUri(image).toString());
    result.status = 'loaded';
    result.detail = `${images.length} image${images.length === 1 ? '' : 's'} from ${localSource.fsPath}`;
  } catch (error: unknown) {
    console.warn('LoomMark could not load the configured Card images.', error);
    result.status = 'error';
    const detail = String(error);
    const blockedUncHost = detail.match(/UNC host '([^']+)' access is not allowed/i)?.[1];
    const allowedUncHosts = vscode.workspace
      .getConfiguration('security')
      .get<string[]>('allowedUNCHosts', []);
    result.detail = blockedUncHost
      ? `${detail} Add ${JSON.stringify(blockedUncHost)} to security.allowedUNCHosts. Current extension host value: ${JSON.stringify(allowedUncHosts)}.`
      : detail;
  }
  return result;
}

class MarkdownOutlineTree implements vscode.TreeDataProvider<OutlineNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<OutlineNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private document: vscode.TextDocument | undefined;
  private roots: OutlineNode[] = [];

  setDocument(document: vscode.TextDocument | undefined): void {
    this.document = document;
    this.refresh();
  }

  updateDocument(document: vscode.TextDocument): void {
    if (document.uri.toString() === this.document?.uri.toString()) {
      this.document = document;
      this.refresh();
    }
  }

  getTreeItem(node: OutlineNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children.length
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = `H${node.level}`;
    item.tooltip = `${'#'.repeat(node.level)} ${node.label}\nLine ${node.line}`;
    item.iconPath = new vscode.ThemeIcon('symbol-key');
    item.command = {
      command: 'loommark.revealHeading',
      title: 'Reveal heading',
      arguments: [node.ordinal],
    };
    return item;
  }

  getChildren(node?: OutlineNode): OutlineNode[] {
    return node?.children ?? this.roots;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private refresh(): void {
    this.roots = this.document ? markdownOutline(this.document.getText()) : [];
    this.changeEmitter.fire(undefined);
  }
}

class LoomMarkProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  activeDocumentUri: vscode.Uri | undefined;
  private activePanel: vscode.WebviewPanel | undefined;
  private readonly activeDocumentEmitter = new vscode.EventEmitter<vscode.TextDocument | undefined>();
  readonly onDidChangeActiveDocument = this.activeDocumentEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    this.setActiveDocument(document, panel);
    const documentDirectory = vscode.Uri.joinPath(document.uri, '..');
    // Relative image and link paths may climb above the document's own directory (a
    // sibling assets folder, for example). Grant the containing workspace folder when
    // one exists so those resolve; a loose file outside any workspace keeps the
    // narrower default of only its own directory.
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const configuredBackgroundRoots = await backgroundResourceRoots();
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        workspaceFolder?.uri ?? documentDirectory,
        ...configuredBackgroundRoots,
      ],
    };
    panel.webview.html = this.html(panel.webview);

    let documentRevision = document.version;
    let applyingClientEdit = false;
    let ready = false;
    let lastBackgroundWarning = '';
    let lastCardImageWarning = '';

    const post = (message: HostToWebview) => panel.webview.postMessage(message);
    const loadConfiguration = async (): Promise<EditorConfiguration> => {
      const background = await resolvedBackground(panel.webview, document);
      const cardImage = await resolvedCardImage(panel.webview);
      if (background.enabled && background.status !== 'loaded') {
        const warning = `${background.status}: ${background.detail ?? 'No usable image path configured.'}`;
        if (warning !== lastBackgroundWarning) {
          lastBackgroundWarning = warning;
          void vscode.window.showWarningMessage(`LoomMark background ${warning}`);
        }
      } else {
        lastBackgroundWarning = '';
      }
      if (cardImage.enabled && cardImage.status !== 'loaded') {
        const warning = `${cardImage.status}: ${cardImage.detail ?? 'No usable image path configured.'}`;
        if (warning !== lastCardImageWarning) {
          lastCardImageWarning = warning;
          void vscode.window.showWarningMessage(`LoomMark Card image ${warning}`);
        }
      } else {
        lastCardImageWarning = '';
      }
      return editorConfiguration(background, cardImage);
    };
    const initialize = async () => post({
      type: 'init',
      text: document.getText(),
      revision: documentRevision,
      resourceBase: ensureTrailingSlash(panel.webview.asWebviewUri(documentDirectory).toString()),
      wikiFiles: await findWikiFiles(document),
      ...await loadConfiguration(),
    });

    const messageSubscription = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      if (!isWebviewMessage(raw)) return;
      if (raw.type === 'ready') {
        ready = true;
        await initialize();
        return;
      }
      if (raw.type === 'openLink') {
        await post({ type: 'linkOpenResult', href: raw.href, status: 'received' });
        const result = await openLink(raw.href, document, raw.wiki ?? false);
        await post({ type: 'linkOpenResult', href: raw.href, ...result });
        return;
      }
      if (raw.type === 'diagnostics') {
        await vscode.env.clipboard.writeText(raw.report);
        void vscode.window.showInformationMessage('LoomMark diagnostics copied to the clipboard.');
        return;
      }

      const current = document.getText();
      const splice = singleSplice(current, raw.text);
      if (!splice) {
        await post({ type: 'ack', clientRevision: raw.clientRevision, documentRevision, text: current });
        return;
      }

      applyingClientEdit = true;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(splice.from), document.positionAt(splice.to)),
        splice.insert,
      );
      const applied = await vscode.workspace.applyEdit(edit);
      applyingClientEdit = false;

      if (applied) {
        documentRevision = document.version;
        await post({
          type: 'ack',
          clientRevision: raw.clientRevision,
          documentRevision,
          text: document.getText(),
        });
      } else {
        await post({ type: 'documentChanged', text: document.getText(), documentRevision });
      }
    });

    const documentSubscription = vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (event.document.uri.toString() !== document.uri.toString()) return;
      documentRevision = event.document.version;
      if (!ready || applyingClientEdit) return;
      await post({ type: 'documentChanged', text: event.document.getText(), documentRevision });
    });

    const configurationSubscription = vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!ready || !event.affectsConfiguration('loommark')) return;
      const backgroundRoots = await backgroundResourceRoots();
      panel.webview.options = {
        ...panel.webview.options,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
          workspaceFolder?.uri ?? documentDirectory,
          ...backgroundRoots,
        ],
      };
      await post({
        type: 'configuration',
        ...await loadConfiguration(),
      });
    });

    const refreshWikiFiles = async () => {
      if (!ready) return;
      await post({ type: 'wikiFilesChanged', wikiFiles: await findWikiFiles(document) });
    };
    const createFilesSubscription = vscode.workspace.onDidCreateFiles(() => {
      void refreshWikiFiles();
    });
    const deleteFilesSubscription = vscode.workspace.onDidDeleteFiles(() => {
      void refreshWikiFiles();
    });
    const renameFilesSubscription = vscode.workspace.onDidRenameFiles(() => {
      void refreshWikiFiles();
    });

    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) this.setActiveDocument(document, panel);
    });
    panel.onDidDispose(() => {
      messageSubscription.dispose();
      documentSubscription.dispose();
      configurationSubscription.dispose();
      createFilesSubscription.dispose();
      deleteFilesSubscription.dispose();
      renameFilesSubscription.dispose();
      if (this.activeDocumentUri?.toString() === document.uri.toString()) {
        this.activeDocumentUri = undefined;
        this.activePanel = undefined;
        this.activeDocumentEmitter.fire(undefined);
      }
    });
  }

  revealHeading(ordinal: number): Thenable<boolean> | undefined {
    return this.activePanel?.webview.postMessage({ type: 'revealHeading', ordinal } satisfies HostToWebview);
  }

  requestDiagnostics(): boolean {
    if (!this.activePanel) return false;
    void this.activePanel.webview.postMessage({ type: 'requestDiagnostics' } satisfies HostToWebview);
    return true;
  }

  dispose(): void {
    this.activeDocumentEmitter.dispose();
  }

  private setActiveDocument(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    this.activeDocumentUri = document.uri;
    this.activePanel = panel;
    this.activeDocumentEmitter.fire(document);
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const stylesheet = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    const nonce = getNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${stylesheet}">
  <title>LoomMark</title>
</head>
<body>
  <div id="workspace">
    <main id="editor" aria-label="Markdown editor"></main>
    <button id="outline-fab" type="button" title="Show outline" aria-label="Show outline" aria-controls="outline" aria-expanded="false">
      <span class="outline-fab-icon" aria-hidden="true"><i></i><i></i><i></i></span>
    </button>
    <aside id="outline" aria-label="Document outline">
      <header class="outline-header">
        <span class="outline-title">Outline</span>
        <button id="outline-toggle" type="button" title="Hide outline" aria-label="Hide outline" aria-controls="outline" aria-expanded="true">
          <span class="outline-toggle-icon" aria-hidden="true"></span>
        </button>
      </header>
      <nav class="outline-nav" aria-label="Headings">
        <ol id="outline-list"></ol>
        <p id="outline-empty">No headings</p>
      </nav>
    </aside>
  </div>
  <div id="status" role="status">Loading editor...</div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

type LinkOpenResult = {
  status: 'opened' | 'error';
  resolvedUri?: string;
  error?: string;
};

async function openLink(
  href: string,
  document: vscode.TextDocument,
  wiki: boolean,
): Promise<LinkOpenResult> {
  const explicitScheme = href.match(/^([a-z][a-z\d+.-]*):/i)?.[1].toLowerCase();
  if (explicitScheme) {
    let external: vscode.Uri;
    try {
      external = vscode.Uri.parse(href, true);
    } catch (error: unknown) {
      return { status: 'error', error: String(error) };
    }
    if (explicitScheme === 'http' || explicitScheme === 'https' || explicitScheme === 'mailto') {
      await vscode.env.openExternal(external);
      return { status: 'opened', resolvedUri: external.toString(true) };
    }
    return {
      status: 'error',
      resolvedUri: external.toString(true),
      error: `Unsupported URI scheme: ${explicitScheme}`,
    };
  }

  let targetPath = href.split('#')[0];
  if (wiki && !path.extname(targetPath)) targetPath += '.md';
  const uri = vscode.Uri.joinPath(document.uri, '..', targetPath);
  try {
    await vscode.workspace.fs.stat(uri);
    await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
    return { status: 'opened', resolvedUri: uri.toString(true) };
  } catch (error: unknown) {
    const detail = String(error);
    void vscode.window.showWarningMessage(
      `LoomMark could not open ${href} (${uri.toString(true)}): ${detail}`,
    );
    return { status: 'error', resolvedUri: uri.toString(true), error: detail };
  }
}

function getNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function ensureTrailingSlash(uri: string): string {
  return uri.endsWith('/') ? uri : `${uri}/`;
}

async function findWikiFiles(document: vscode.TextDocument): Promise<string[]> {
  const files = await vscode.workspace.findFiles(
    '**/*',
    '**/{.git,node_modules,.vscode-test}/**',
    3000,
  );
  const directory = path.posix.dirname(document.uri.path);
  return files
    .filter((uri) => uri.toString() !== document.uri.toString())
    .map((uri) => {
      const relative = path.posix.relative(directory, uri.path);
      // Only Markdown files follow the Obsidian-style extensionless convention; every
      // other file (a script, a config, an image) keeps its extension, since that is
      // what tells a reader what kind of file the link points to.
      return /\.(?:md|markdown)$/i.test(relative) ? relative.replace(/\.(?:md|markdown)$/i, '') : relative;
    })
    .sort((left, right) => left.localeCompare(right));
}

export function deactivate(): void {}
