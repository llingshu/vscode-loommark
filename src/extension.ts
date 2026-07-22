import * as vscode from 'vscode';
import * as path from 'node:path';
import { markdownOutline, type OutlineNode } from './outline';
import type { EditorConfiguration, HostToWebview, OutlineMode, EditorTheme, TableMode, TableStyle, OrderedListStyle } from './protocol';
import { isWebviewMessage } from './protocol';
import { singleSplice } from './text';

const viewType = 'loommark.editor';

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
      const current = configuration.get('cardMode', true);
      await configuration.update('cardMode', !current, vscode.ConfigurationTarget.Global);
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

function editorConfiguration(): EditorConfiguration {
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
  return {
    syncDelay: configuration.get('syncDelay', 180),
    theme,
    outline,
    table,
    tableStyle,
    orderedListStyle,
    keyboardEditing: configuration.get('keyboardEditing', false),
    listGuides: configuration.get('listGuides', true),
    cardMode: configuration.get('cardMode', true),
  };
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
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        workspaceFolder?.uri ?? documentDirectory,
      ],
    };
    panel.webview.html = this.html(panel.webview);

    let documentRevision = document.version;
    let applyingClientEdit = false;
    let ready = false;

    const post = (message: HostToWebview) => panel.webview.postMessage(message);
    const initialize = async () => post({
      type: 'init',
      text: document.getText(),
      revision: documentRevision,
      resourceBase: ensureTrailingSlash(panel.webview.asWebviewUri(documentDirectory).toString()),
      wikiFiles: await findWikiFiles(document),
      ...editorConfiguration(),
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
      await post({ type: 'configuration', ...editorConfiguration() });
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
