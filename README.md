# LoomMark

[![CI](https://github.com/llingshu/vscode-loommark/actions/workflows/ci.yml/badge.svg)](https://github.com/llingshu/vscode-loommark/actions/workflows/ci.yml)
[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/llingshu.loommark)](https://marketplace.visualstudio.com/items?itemName=llingshu.loommark)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f7d76.svg)](LICENSE)

LoomMark is a source-preserving Markdown editor for Visual Studio Code. It combines a continuous
CodeMirror editing surface with progressive rich rendering while keeping the exact Markdown text
as the only source of truth.

LoomMark does not parse a document into a rich-text model and serialize the whole document back to
Markdown. Visual features are CodeMirror decorations layered over the original text. Opening a
file must not format, normalize, escape, or otherwise rewrite it.

## Highlights

- Continuous editing with normal cursor movement, selection, undo, IME composition, and fast input.
- Progressive rendering for headings, emphasis, strong text, strikethrough, links, and inline code.
- Fenced code blocks with language-aware highlighting, line numbers, copy controls, and language
  selection.
- Obsidian-style `[[wiki links]]` and `[[target|label]]` without conversion to standard links.
- Workspace Markdown file completion inside `[[...]]`.
- Ctrl/Cmd + click navigation for relative Markdown links and wiki links.
- An in-editor outline drawer that opens from a floating control, plus a native Explorer outline,
  both generated from source text.
- Minimal VS Code `WorkspaceEdit` synchronization with stale-update protection.
- Built-in diagnostics command for inspecting the Webview, synchronization state, links, completion,
  and code-block decorations.

## Source Fidelity

The `TextDocument` owned by VS Code is the persistence authority. LoomMark follows these rules:

1. Opening a document never changes it.
2. Decorations change presentation, not text.
3. Unsupported syntax remains original source text.
4. Only direct user input or an explicit command may create a document edit.
5. Host acknowledgements cannot overwrite newer local typing.
6. Formatting, if introduced, must be explicit, previewable, and undoable.

This matters for Markdown dialects, repository conventions, external generators, note-taking
workflows, embedded HTML, deliberate escapes, and tools that depend on exact source layout.

## Installation

Install **LoomMark** from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=llingshu.loommark),
or install a packaged VSIX:

```bash
code --install-extension artifacts/loommark.vsix
```

Markdown files open with LoomMark by default. Use **Reopen Editor With...** to select another
editor for an individual document, or disable `loommark.openByDefault`.

## Commands

| Command | Purpose |
| --- | --- |
| `LoomMark: Open Source Editor` | Reopen the current document in VS Code's default text editor. |
| `LoomMark: Focus Markdown Outline` | Open Explorer and focus LoomMark's native outline. |
| `LoomMark: Copy Editor Diagnostics` | Copy structured runtime diagnostics for bug reports. |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `loommark.openByDefault` | `true` | Associate `*.md` and `*.markdown` with LoomMark at user scope. |
| `loommark.theme` | `vscode` | Select `vscode`, `crepe`, `frame`, or `nord`. |
| `loommark.table` | `rich` | Edit table cells in place (`rich`) or expand to Markdown source on cursor entry (`source`). |
| `loommark.tableStyle` | `grid` | Render tables as a bordered `grid` or a booktabs-style three-line `ruled` table. |
| `loommark.keyboardEditing` | `false` | Let the cursor enter rendered images, tables, and math with the keyboard. When off, they are edited on click. |
| `loommark.outline` | `both` | Show the outline in `both`, `editor`, `explorer`, or turn it `off`. |
| `loommark.syncDelay` | `180` | Debounce duration in milliseconds before syncing local typing to VS Code. |

## Wiki Links

LoomMark preserves and renders both common wiki-link forms:

```md
[[notes/project]]
[[notes/project|Project notes]]
```

Typing `[[` opens completion for Markdown files in the workspace. Candidates are relative to the
current document and omit `.md` or `.markdown`. The list refreshes when files are created, deleted,
or renamed. Ctrl/Cmd + click opens a target; an extensionless wiki link first resolves as `.md`.

## Code Blocks

Fenced code blocks use the language following the opening fence:

````md
```typescript
const message: string = "hello";
```
````

The code-block UI is a view layer. Copy does not include fences. Changing the language selector is
an explicit, undoable edit to the opening fence only. Terminal-like languages receive restrained
window chrome; other languages use neutral controls.

## Privacy

LoomMark processes documents locally inside VS Code. It includes no analytics, advertising,
telemetry, remote document service, or background upload. External links open only after an explicit
user action.

## Development

Requirements: Node.js 20 or later and VS Code 1.95 or later.

```bash
npm ci
npm run check
npm run build
```

Press `F5` to launch an Extension Development Host. Use `npm run watch` while editing. Package the
same artifact used for both registries with:

```bash
npm run package
```

Detailed documentation:

- [Architecture](docs/ARCHITECTURE.md)
- [Editor technology](docs/EDITOR_TECHNOLOGY.md)
- [Development and debugging](docs/DEVELOPMENT.md)
- [Publishing](docs/PUBLISHING.md)
- [Contributing](CONTRIBUTING.md)

## Limitations

- Host synchronization currently applies the smallest single contiguous replacement. Concurrent
  overlapping edits from another editor are not rebased.
- Progressive rendering intentionally covers a defined Markdown subset. Unimplemented syntax stays
  visible and editable rather than being discarded.
- Only one LoomMark custom editor is supported per text document.
- The complete language-data bundle increases the Webview bundle size; language splitting remains
  future optimization work.

## Acknowledgements

LoomMark is built with [CodeMirror 6](https://codemirror.net/),
[Lezer](https://lezer.codemirror.net/), [mdast](https://github.com/syntax-tree/mdast), and the
[Visual Studio Code Extension API](https://code.visualstudio.com/api). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)
for dependency license information.

## Citation And License

Use [CITATION.cff](CITATION.cff) to cite LoomMark. The project is released under the
[MIT License](LICENSE).
