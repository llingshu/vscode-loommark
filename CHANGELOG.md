# Changelog

All notable changes to LoomMark are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.3] - 2026-07-23

### Added

- `loommark.background.path` and `loommark.cardImage.path` accept an `https://` URL, loaded
  directly by the Webview instead of being resolved as a local file. A URL is always a single
  fixed image; `loommark.background.selection`'s directory-rotation modes only apply to a local
  directory.

## [0.4.2] - 2026-07-23

### Fixed

- `loommark.keyboardEditing` had no effect: with it off (the default), arrow-key motion was meant
  to skip clean over a rendered table/image/math widget, but instead walked through it one
  character at a time, identically to it being on. The range that blocks keyboard entry was
  derived from whether a widget was *currently* rendered there, which those fields stop doing the
  instant the cursor first touches the widget's own boundary — the same position CodeMirror
  already treats as a legal approach point — so reaching that boundary immediately cleared the
  very protection the next keystroke needed, letting the cursor slip in one edge at a time
  regardless of the setting.

## [0.4.1] - 2026-07-23

### Changed

- `loommark.cardColors` is replaced by `loommark.cardBackgroundColors` and
  `loommark.cardBorderColors`, so Card background fill and border/rail color can be customized
  independently instead of sharing one color list. Setting either to an empty array now means no
  color at all for that layer (no background tint, or no border/rail), rather than falling back
  to the built-in palette; the built-in six-hue palette is instead the setting's shipped default,
  so the out-of-the-box look is unchanged until you edit the setting.

## [0.4.0] - 2026-07-23

### Added

- Optional local image backgrounds behind the editor, with fixed, random-on-open, daily, or
  per-document selection, plus independently configurable opacity, blur, saturation, and
  theme-colored readability overlay (`loommark.background.*`).
- Optional per-heading-section image backgrounds (`loommark.cardImage.*`) in Card mode's `card`
  and `tint` styles, with stable heading-based selection (editing or reopening the document does
  not reshuffle which image a section gets), an independent path or reuse of the global background
  directory, opacity, blur, saturation, and readability overlay.
- `loommark.cardColors` customizes the per-level color cycle Card mode uses in place of the
  built-in six-hue palette; `loommark.cardBackgroundStrength` and `loommark.cardBorderStrength`
  separately tune how strongly that color shows in Card backgrounds versus borders.

### Changed

- Card mode's rounded `card` style now draws nested sections with real per-level rounded borders
  (previously only the outermost level got a rounded border; deeper levels closing on the same
  line got a plain straight edge).

### Fixed

- Card mode's background was far too dark for comfortable reading, and card content (paragraphs,
  code blocks, blockquotes) sat flush against the card's own border. Backgrounds are now a light
  tint mixed against the editor surface, and content is padded inward from the border on all three
  visible styles (`tint`, `accent`, `card`).
- The `tint` and `accent` Card mode styles did not inset content the same way `card` did: `tint`
  let paragraphs and code blocks overhang into ancestor color bands, and `accent`'s content padding
  overwrote a fenced code block's own line-number gutter, shifting code text on top of the gutter.
  Fenced code blocks are now contained the same way in all three styles.
- A fenced code block's toolbar and its code lines could be misaligned by a pixel on each side,
  visible as a jagged edge at some zoom levels or display scales.
- Card mode's per-heading background image could extend past its section's own border or rounded
  corner, most noticeably where a nested section closed. Image bounds are now measured against the
  actual rendered line elements (which carry CSS margins CodeMirror's own height map cannot see)
  and kept inside every drawn border, rail, and closing-gap clearance.

## [0.3.1] - 2026-07-20

### Added

- Backslash escapes (`\*`, `\_`, `\#`, `\!`, and other CommonMark-escapable punctuation) hide the
  backslash and leave the character as plain text instead of live Markdown syntax.
- The cursor position is remembered and restored when a document is reopened in the same Webview
  session (closing and reopening the editor tab, or a VS Code reload).
- Tab and Shift+Tab indent and outdent the current line (or all selected lines) by 4 spaces, which
  is how a list item becomes a nested sub-list.
- `loommark.orderedListStyle` renumbers nested ordered lists for display: a cycling `1, a, i`
  style that repeats every three levels (the default), or hierarchical decimal
  (`1, 2, 2.1, 2.2, 2.2.1`). The source keeps whatever number was typed; only the rendered label
  changes, and unlike other hidden markup it never reveals the literal number when the cursor
  enters the line (a *different* displayed number would be confusing, not informative) — click
  a label to edit the source number instead.
- `loommark.listGuides` (default on) draws a connector line between a list item, its nested
  children, and any indented continuation content (a paragraph, blockquote, or code block)
  underneath it. Guides are always visible, including on the cursor's own line (there is no
  source syntax to reveal there, only blank space). Gray by default; the cursor's own line and
  each of its direct ancestor items' lines light up in color, one per nesting level — sibling
  branches and unrelated content sharing part of the same connector stay gray.
- Card mode (`loommark.cardMode`, default `card`): visually sets apart each heading's section,
  nested one inside another for sub-headings, so it is clear which heading a given line is under.
  Three styles — `tint` (soft background wash), `accent` (colored left border bar), `card`
  (bordered, rounded box with content padded inward from its own border) — plus `off`, cycled with
  the new `LoomMark: Toggle Heading Card Mode` command, also in the editor title bar. Colors cycle
  through the same six-hue palette as list guides by default, or a custom list via the new
  `loommark.cardColors` setting.
- Optional local image backgrounds with fixed, random-on-open, daily, or per-document selection,
  plus independently configurable opacity, blur, saturation, and theme-colored readability overlay.

### Changed

- Ctrl/Cmd + click on an image now opens it, the same way it already does for links. This works
  whether the image is rendered or shown as Markdown source (cursor inside it).
- An image's raw Markdown source (cursor inside it) now gets a highlighted background, with its
  destination colored like a link, so it stays easy to find after clicking into it.
- `[[wiki link]]` completion and navigation now cover every workspace file, not only Markdown —
  scripts, configs, images, and so on. Markdown files still omit their extension in the completion
  list; other files keep theirs, since it identifies the file type and is required for `openLink`
  to resolve them as-is instead of assuming `.md`.

### Fixed

- A backslash-escaped delimiter (`\*`, `\#`, `\![`) is no longer treated as live Markdown syntax;
  previously an escaped marker could still trigger emphasis, tag, image, or link rendering, or
  incorrectly pair with unrelated real syntax later in the same line.
- Clicking Next/Previous in find and replace no longer breaks the search panel when the match is
  inside a table, image, or math block. `loommark.keyboardEditing`'s atomic ranges were also being
  applied to those blocks' already-revealed source text, not just their widgets, which could put
  the cursor somewhere CodeMirror considered simultaneously selected and unenterable.
- Pressing Enter could stop creating a new line partway through a deeply nested ordered list.
  List nesting used a fixed 2-space-per-level indent, which satisfies bullet markers but not
  ordered ones — CommonMark only recognizes a nested item once its content reaches its parent's
  content column (3+ characters for `1. `, more for multi-digit numbers). Once an ordered item's
  indent fell short, CodeMirror's Markdown parser stopped treating it as a nested list at all and
  folded it into the parent item's paragraph instead, so there was no list left for Enter to
  continue. List nesting (Tab/Shift+Tab, rendered levels, guide lines, ordered-list numbering)
  now uses 4 spaces per level everywhere, which satisfies every realistic marker width.
- The text cursor no longer disappears after switching away from VS Code (or this editor's tab)
  and back. VS Code refocuses the Webview container on return, but has no way to know which
  inner element should get focus back, so it was left on `<body>` — and a browser never draws a
  caret in a non-focused editable region. Focus is now restored to the editor automatically,
  unless something else inside the Webview (an outline button, a table cell) already
  legitimately reclaimed it.

## [0.3.0] - 2026-07-20

### Added

- KaTeX-rendered math: inline `$...$` and display `$$...$$` blocks follow the same
  render-outside/edit-inside model as other progressive syntax. Currency-like text stays plain.
- `loommark.keyboardEditing` lets the text cursor enter rendered images, tables, and math with the
  keyboard for mouse-free editing. Disabled by default, so these render as atomic click-to-edit
  regions.
- `loommark.tableStyle` adds a booktabs-style `ruled` three-line table appearance alongside the
  default bordered `grid`.
- `#tag` chips: standalone hashtags render as pills without hiding the `#`, since it carries
  meaning. Heading markers, mid-word hashes, and numeric references like `#123` are not treated
  as tags.
- Find and replace inside the editor (Ctrl/Cmd+F), backed by CodeMirror's search panel and styled
  as a floating card anchored to the editor's top-right corner, matching VS Code's native find
  widget instead of a full-width bar clipped to the editor column.

### Changed

- The in-editor outline is now an overlay drawer opened from a floating control in the top-right
  corner. It no longer reserves a column, so the editor uses the full width until the outline is
  opened. Escape closes it.
- Local resources for images and links now resolve within the document's whole workspace folder,
  not just its own directory, so relative paths that climb to a sibling folder (`../assets/x.png`)
  load correctly.

### Fixed

- The third-party license generator now matches package license filenames case-insensitively, so
  regeneration on case-sensitive filesystems no longer drops license texts.
- Image and link destinations wrapped in angle brackets (`` [label](<path with spaces>) ``) now
  parse correctly instead of including the brackets in the resolved path.
- Text inside image and link destinations (a filename like `a_b_c.png`) is no longer scanned for
  emphasis, so underscores in paths and titles don't get partially hidden as italics.
- Single-character bold, italic, and strikethrough (`**a**`, `*a*`, `_a_`, `~~a~~`) now hide their
  markers like longer spans; previously the markers stayed visible permanently.
- The packaged VSIX no longer includes the Node test bundle output (`out/test/`), which was
  unintentionally shipped because `.vscodeignore` never excluded it.

## [0.2.0] - 2026-07-19

### Added

- GitHub community health files, continuous integration, release automation, citation metadata,
  and third-party notices.
- Collapsible in-editor outline and native Explorer TreeView with AST-based heading navigation.
- Source-preserving CodeMirror editing core with stale-update protection.
- Progressive heading, emphasis, link, wiki-link, inline-code, and fenced-code presentation.
- Wiki-link workspace completion and Ctrl/Cmd + click navigation.
- Language-aware code blocks with line numbers, copy controls, an explicit language selector, and a
  One Dark / One Light styled titlebar with macOS-style window controls.
- Runtime editor diagnostics command for reproducible Webview bug reports.
- Progressive GFM table rendering with click-to-edit cells. The `loommark.table` setting switches
  between in-place `rich` editing (default) and the previous `source` expand-on-cursor behavior.
- Inline and block image preview resolved against the document's resource base, with a fallback
  placeholder for images that fail to load.
- Clickable task-list checkboxes, styled bullet levels for nested lists, blockquote styling, and
  horizontal rule rendering.

### Changed

- Replaced the Milkdown/ProseMirror serialization pipeline with a continuous source-backed
  CodeMirror document. Opening a file no longer normalizes Markdown through a rich-text serializer.

## [0.1.0] - 2026-07-10

### Added

- Source-backed Milkdown Crepe editor for Markdown files.
- Batched synchronization through minimal `WorkspaceEdit` replacements.
- External document change handling and CJK composition-aware input.
- Headings, lists, tables, code blocks, selection toolbar, and slash commands.
- VS Code, Crepe, Frame, and Nord palettes with light and dark variants.
- Configurable default-editor association and synchronization delay.
- Source-editor command in the custom editor title bar.

[Unreleased]: https://github.com/llingshu/vscode-loommark/compare/v0.4.3...HEAD
[0.4.3]: https://github.com/llingshu/vscode-loommark/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/llingshu/vscode-loommark/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/llingshu/vscode-loommark/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/llingshu/vscode-loommark/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/llingshu/vscode-loommark/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/llingshu/vscode-loommark/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/llingshu/vscode-loommark/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/llingshu/vscode-loommark/releases/tag/v0.1.0
