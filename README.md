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
- GFM tables that render as real tables, editable in place or as expand-to-source widgets, in a
  bordered grid or a booktabs-style three-line layout.
- Inline and block image preview, including images in a sibling folder or wrapped in `<...>`.
- Inline and display math rendered with KaTeX.
- Clickable task-list checkboxes, styled nested bullets, blockquotes, and horizontal rules.
- Tab/Shift+Tab indent and outdent lines, turning a list item into a nested sub-list. Nested
  ordered lists renumber automatically (`1, 2, 2.1, 2.2` by default).
- `#tag` chips that stay part of the editable text.
- Backslash escapes (`\*`, `\#`, `\!`, ...) turn off Markdown syntax for a single character.
- Find and replace inside the editor (Ctrl/Cmd+F), styled like VS Code's native find widget.
- Obsidian-style `[[wiki links]]` and `[[target|label]]` without conversion to standard links.
- Workspace-wide file completion inside `[[...]]` — any file, not just Markdown.
- Ctrl/Cmd + click navigation for relative Markdown links and wiki links.
- An in-editor outline drawer that opens from a floating control, plus a native Explorer outline,
  both generated from source text.
- Minimal VS Code `WorkspaceEdit` synchronization with stale-update protection.
- Cursor position is remembered and restored when reopening a document.
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
| `loommark.orderedListStyle` | `decimal` | Number nested ordered lists `1, 2, 2.1, 2.2` (`decimal`) or cycle arabic/letters/roman numerals per level (`cycle`). |
| `loommark.keyboardEditing` | `false` | Let the cursor enter rendered images, tables, and math with the keyboard. When off, they are edited on click. |
| `loommark.outline` | `both` | Show the outline in `both`, `editor`, `explorer`, or turn it `off`. |
| `loommark.syncDelay` | `180` | Debounce duration in milliseconds before syncing local typing to VS Code. |

## Wiki Links

LoomMark preserves and renders both common wiki-link forms:

```md
[[notes/project]]
[[notes/project|Project notes]]
```

Typing `[[` opens completion for **any file in the workspace**, not just Markdown — scripts,
configs, images, and so on. Candidates are relative to the current document; Markdown files omit
their `.md`/`.markdown` extension (Obsidian-style), other files keep theirs since it identifies
the file type. The list refreshes when files are created, deleted, or renamed. Ctrl/Cmd + click
opens a target; an extensionless wiki link resolves as `.md`, one with an extension opens as-is.

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

## Rendered Widgets

Tables, images, and math render as widgets rather than plain decorated text. By default the text
cursor skips over them and they are edited by clicking into them; enable `loommark.keyboardEditing`
to let the cursor step in with the keyboard instead, for mouse-free editing.

## Tables

GFM tables render as real `<table>` elements. `loommark.table` controls how cells are edited:

- `rich` (default) — click a cell to edit its raw Markdown in place. Enter or clicking elsewhere
  commits the change, Escape cancels, and Tab/Shift+Tab moves to the next/previous cell.
- `source` — the whole table expands to Markdown source when the cursor enters it, matching the
  edit style used for headings and emphasis.

`loommark.tableStyle` switches the visual style between a bordered `grid` (default) and a
booktabs-style three-line `ruled` table (heavy top/bottom rules, a header rule, light row
separators, no vertical lines) — useful for reference tables like a CLI command list.

## Images

`![alt](path)` renders inline or, on its own line, as a block image. Relative paths resolve
against the document's own directory and may climb into a sibling folder (`../assets/x.png`) as
long as the target stays inside the document's workspace folder; documents opened outside any
workspace can only reach their own directory. Paths with spaces or special characters can be
wrapped in angle brackets: `![alt](<../My Assets/figure 1.png>)`. Remote `http(s):` and `data:`
sources are used as-is. An image that fails to load shows a placeholder instead of breaking the
line. Click an image to edit its Markdown source; Ctrl/Cmd + click opens it instead, whether the
image is rendered or shown as source. The raw source gets a highlighted background and a
link-colored destination while the cursor is inside it, so it stays easy to find.

## Math

Math is rendered locally with [KaTeX](https://katex.org/) — no network request is made. Inline
math uses `$...$` and display math uses `$$...$$` (including multi-line blocks). Currency-like
text (`$5`, `$10`) is left as plain text. Invalid LaTeX shows KaTeX's inline error instead of
breaking the editor.

## Tags

A standalone `#word` or `#nested/tag` renders as a pill. The `#` stays part of the editable text
since it carries meaning, unlike heading or emphasis markers. Heading markers (`# Heading`),
hashes in the middle of a word (`foo#bar`), and numeric references (`#123`) are not treated as
tags.

## Search And Replace

Ctrl/Cmd+F opens a find panel inside the editor with case-sensitive, regular-expression, and
whole-word toggles, plus replace and replace-all. Escape closes it.

## Escaping

A backslash before CommonMark's escapable punctuation (``!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~``) hides
the backslash and renders the character as plain text instead of live Markdown syntax:
`\*not bold\*`, `\#not a tag`, `\![not an image](x.png)`. Escapes are ignored inside code, matching
CommonMark.

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
[Lezer](https://lezer.codemirror.net/), [mdast](https://github.com/syntax-tree/mdast),
[KaTeX](https://katex.org/), and the
[Visual Studio Code Extension API](https://code.visualstudio.com/api). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)
for dependency license information.

## Citation And License

Use [CITATION.cff](CITATION.cff) to cite LoomMark. The project is released under the
[MIT License](LICENSE).
