# LoomMark

[![CI](https://github.com/llingshu/vscode-loommark/actions/workflows/ci.yml/badge.svg)](https://github.com/llingshu/vscode-loommark/actions/workflows/ci.yml)
[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/llingshu.loommark)](https://marketplace.visualstudio.com/items?itemName=llingshu.loommark)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f7d76.svg)](LICENSE)

LoomMark is a source-backed, live-rendering Markdown editor for Visual Studio Code. It offers
direct rich-text editing while keeping VS Code's `TextDocument` as the source of truth for saves,
Git integration, external changes, and editor lifecycle behavior.

## Features

- Edit headings, lists, tables, code blocks, links, and common Markdown constructs in place.
- Use selection toolbars and slash commands powered by Milkdown Crepe.
- Keep edits synchronized with the underlying Markdown file through minimal text replacements.
- Continue using VS Code dirty state, file watching, source control, and external file updates.
- Compose CJK text without sending incomplete input-method updates.
- Follow the active VS Code light, dark, or high-contrast appearance.
- Choose the VS Code, Crepe, Frame, or Nord editor palette.
- See compact `H1` through `H6` indicators without changing the Markdown source.
- Navigate a collapsible, live-updating outline with current-section highlighting.

## Installation

Install **LoomMark** from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=llingshu.loommark),
or install a release VSIX from the repository:

```bash
code --install-extension loommark.vsix
```

After installation, Markdown files open with LoomMark by default. Use the code icon in the
editor title bar to reopen the current file in VS Code's source editor.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `loommark.openByDefault` | `true` | Maintains user-level editor associations for `*.md` and `*.markdown`. Disabling it removes only associations owned by LoomMark. |
| `loommark.theme` | `vscode` | Selects `vscode`, `crepe`, `frame`, or `nord`. Non-VS Code palettes still follow the active light or dark appearance. |
| `loommark.outline` | `both` | Shows the document outline in `both`, the `editor`, the native `explorer`, or turns it `off`. |
| `loommark.syncDelay` | `180` | Groups continuous input for this many milliseconds before synchronizing it to the source document. |

You can also select **Reopen Editor With...** from the editor context menu to choose an editor for
an individual file.

The native **Markdown Outline** view appears in VS Code's Explorer while a LoomMark editor is
active. Selecting a heading in either outline reveals the same heading in the editor, including
when a document contains duplicate heading text.

## Data And Privacy

LoomMark processes documents locally inside VS Code. The extension does not include analytics,
telemetry, advertising, network requests, or a remote document service. Markdown images that use
remote URLs are loaded by VS Code's Webview under its content security policy.

## Current Limitations

- Synchronization currently represents each editor update as the smallest single contiguous text
  replacement. Concurrent overlapping edits from another editor are not yet rebased.
- Markdown syntax unsupported by Milkdown's parser may not round-trip perfectly. Review unusual
  extensions or dialect-specific constructs before relying on rich-text editing.
- Only one LoomMark editor is supported per text document at a time.

See [DESIGN.md](DESIGN.md) for synchronization invariants and the lossless-source roadmap.

## Development

Prerequisites are Node.js 20 or later and VS Code 1.95 or later.

```bash
npm ci
npm run check
npm run compile
```

Open the repository in VS Code and press `F5`. The Extension Development Host rebuilds the
extension before launch. Additional commands:

```bash
npm run watch      # rebuild on source changes
npm run build      # create production bundles
npm run package    # validate and create artifacts/loommark.vsix
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. Security issues should follow
[SECURITY.md](SECURITY.md); usage questions are covered by [SUPPORT.md](SUPPORT.md).

## Acknowledgements

LoomMark is built on [Milkdown](https://milkdown.dev/),
[Crepe](https://milkdown.dev/docs/guide/using-crepe/),
[ProseMirror](https://prosemirror.net/), [CodeMirror](https://codemirror.net/), and the
[Visual Studio Code Extension API](https://code.visualstudio.com/api). Their maintainers and
contributors make this editor possible. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for
license details.

## Citation And License

To cite this software, use the metadata in [CITATION.cff](CITATION.cff). LoomMark is released
under the [MIT License](LICENSE).
