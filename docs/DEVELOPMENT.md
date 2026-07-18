# Development And Debugging

## Prerequisites

- Node.js 20 or later
- npm
- Visual Studio Code 1.95 or later

Install and validate:

```bash
npm ci
npm run check
npm run build
```

## Running The Extension

Open the repository in VS Code and press `F5`. The tracked `.vscode/launch.json` starts an Extension
Development Host. Run the incremental builder in a terminal while editing:

```bash
npm run watch
```

After a Webview bundle change, reload the Extension Development Host or close and reopen the
Markdown editor. Existing Webviews do not automatically replace already loaded JavaScript.

## Commands

```bash
npm test          # Node regression tests
npm run check     # TypeScript and tests
npm run compile   # development bundles with source maps
npm run build     # minified production bundles
npm run package   # clean, validate, build, license, and create VSIX
```

Generated files belong in `dist/` and `artifacts/` and are ignored by Git.

## Debugging Layers

LoomMark has two JavaScript environments:

1. Extension host: `src/extension.ts`
2. Isolated Webview: `webview/main.ts`

Errors in one do not automatically appear in the other's console. Use the extension-host debugger
for provider and filesystem behavior. Use **Developer: Toggle Developer Tools** for Webview runtime
errors.

### Diagnostics Command

Run **LoomMark: Copy Editor Diagnostics** with an active LoomMark editor. The command requests a
report from the Webview and copies it to the clipboard. The report includes:

- editor/document revisions and pending edits;
- exact CodeMirror text;
- initialization errors;
- wiki completion candidates and status;
- source and DOM link matches;
- last pointer, link request, and host result;
- parsed fenced-code ranges;
- editor, code-line, and cursor classes/computed styles;
- rendered line HTML.

This command is preferred to asking users to find the Webview JavaScript context in Electron DevTools.

### Common Failures

**The editor is blank**

Check `editorInitializationError`. Initialization exceptions are rendered in the editor and included
in diagnostics.

**Decorations exist for headings but not inline syntax**

Verify `Decoration.set(ranges, true)`. Scanner output is not necessarily ordered by source offset.

**Block widget throws `Block decorations may not be specified via plugins`**

Move the block decoration to a `StateField` and expose it through `EditorView.decorations.from()`.

**A relative link resolves to `file:///target`**

Do not call `Uri.parse` on relative text. Detect explicit URI schemes first, then resolve relative
paths with `Uri.joinPath(document.uri, '..', target)`.

**The caret ignores `.cm-cursor` styling**

The editor may be using the native caret. Apply `caret-color` to `.cm-content` under an editor state
class.

**Wiki completion only updates after reopening**

Confirm create/delete/rename listeners post `wikiFilesChanged` and inspect `wikiFileCount`.

## Testing Expectations

At minimum, manually test:

- rapid typing and deletion;
- CJK composition;
- undo and redo;
- external source edits;
- `[[wiki links]]`, HTML, deliberate escapes, and blank lines;
- Ctrl/Cmd + click navigation;
- new-file completion refresh;
- light and dark themes;
- fenced code languages, copy, line numbers, and language changes;
- opening and closing the editor without source changes.

Automated tests should prioritize source invariants and range logic. Visual behavior should be
validated in the Extension Development Host and documented with screenshots when changed.

## Dependency And License Updates

Production bundles include browser dependencies. After dependency changes run:

```bash
npm run licenses
```

Commit `package.json`, `package-lock.json`, and the regenerated `THIRD_PARTY_LICENSES.txt` together.

## Packaging

```bash
npm run package
code --install-extension artifacts/loommark.vsix
```

Use a clean VS Code profile for release smoke tests. Follow [PUBLISHING.md](PUBLISHING.md) for
registry publication.
