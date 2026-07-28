# Changelog

All notable changes to LoomMark are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Experimental margin annotations: a block opened and closed by a line containing only `<<<`
  attaches a left-margin note to the line (or table/fenced-code/display-math block, or a list
  item's own shift+enter continuation) directly above it; `>>>` attaches a right-margin note the
  same way. The block never renders as part of the document and is invisible to every other
  Markdown construct — list numbering, guide rails, heading sections — not just to its own
  rendering. Typing a 3rd `<` or `>` on an empty line auto-closes the block immediately, so a bare
  opener can never accidentally run on and swallow real content up to the next `<<<`/`>>>` line
  anywhere later in the document. Stacking several blocks back to back (either side) all attach to
  the same original line rather than to each other. A color-coded accent stripe — a real overlay
  element, not a background painted onto the line itself — links the attached content to its
  same-colored, cleanly-tinted note, which renders pinned flush to the true left/right edge of the
  editor — outside the editing area and unaffected by heading Card mode's own indentation — the
  same way whenever there's room for it there (or forced open via a right-click "Pin" regardless),
  falling back to a hover-revealed stripe otherwise (the stripe is the hover target itself — no
  separate marker icon duplicating it); each note can be individually collapsed or edited directly,
  and delete/add-note/pin live in a right-click menu rather than always-visible buttons. A card's
  height is user-resizable, scrolling once content exceeds it, with a scrollbar themed to match.
  Several notes on the same target each get their own card, stacked in the margin like any other,
  rather than being crammed into one shared card. A note only draws a connector back to its stripe
  when it actually needed to be displaced to avoid overlapping another card — several notes sharing
  one target inevitably need this, but a lone note usually won't draw one at all — anchored to the
  note's own stripe position (near the text, not the card's edge, since the card's position can
  shift in ways the stripe never does); notes anchored close together on the same side never
  overlap: they pack top to bottom in document order like Word/Google Docs margin comments. See the
  README for the current limitations of this first pass.

The webview now consumes `@llingshu/loommark-core`, a separately-published, portable CodeMirror 6
Markdown kernel extracted from this project's own editor, rather than maintaining its own copy of
the scanners/widgets/decorations directly. No behavior change is expected from this alone; it's
what makes the annotation feature above possible without forking that logic.

## [0.4.5] - 2026-07-26

### Added

- Arrow keys move between table cells while editing one: Up/Down always move to the cell directly
  above/below, and Left/Right move to the adjacent cell once the caret has nowhere left to go
  within the current cell's own text (so normal in-text cursor movement, including word jumps,
  still works everywhere else). Previously only Tab/Shift+Tab could move between cells.

- `Alt+Shift+Up`/`Down`/`Left`/`Right` while editing a table cell inserts an empty row above/below
  or column left/right of the current cell, and pressing Tab past the last cell of the last row
  now extends the table with a new row instead of doing nothing — table row/column layout was
  previously only editable by hand-editing the raw Markdown pipes.
- Inline (`$...$`) and display (`$$...$$`) math inside a table cell now renders with KaTeX; it was
  previously left as unrendered raw text, since table cell rendering never ran math through KaTeX
  in the first place.

### Fixed

- With `loommark.keyboardEditing` on, Up/Down still skipped clean over a table the same way they
  did before block widgets gained keyboard entry, unlike image/math which now correctly enter. A
  rendered table never reveals as plain source the way image/math widgets do — its cells are edited
  in place via a small contentEditable island that only ever starts on a click — so simply moving
  the CodeMirror selection into its range had nothing to land on. Up/Down landing next to a table
  now starts editing its first/last cell directly, the same as a click would.

## [0.4.4] - 2026-07-25

### Added

- Shift+Enter at the end of a list item's own marker line now indents the new line one level
  deeper than the marker, matching this project's fixed per-level indent width, so it is correctly
  recognized as that item's own continuation content instead of reading as a dedent. Pressing
  Shift+Enter again from a line that is already correctly indented continuation content still just
  matches that line's indent, as before — only the first break directly off a marker line needed
  the extra step in.

### Fixed

- List guide rails and the cursor-position highlight only lit up an item's own marker line and the
  cursor's exact line, so a line produced by a soft line break (Shift+Enter) partway through a list
  item's own multi-line content stayed gray even though it is logically the same paragraph, just
  visually wrapped onto more lines. The whole contiguous run of such lines directly belonging to
  the cursor's own item now lights up together; a nested sub-item one level deeper still only
  lights up when the cursor is actually on or under it, not just because it shares a parent with
  the highlighted item.
- A rendered table, image, or math block would revert to raw Markdown source the instant a range
  (non-collapsed) selection extended across it — while dragging or shift-clicking to select a span
  of text that includes one, for example — even though nothing was placed inside it to edit.
  Revealing now checks whether the *whole* selection stays within the block, not just where it
  currently ends: a selection made within already-revealed source (to copy part of it) still
  reveals correctly, but one that extends across a still-rendered block from outside no longer
  disrupts it.

### Added

- Pasting an image from the clipboard saves it to disk and inserts a Markdown image link at the
  cursor. The destination folder reuses VS Code's own `markdown.copyFiles.destination` setting —
  the same one the built-in Markdown editor already honors for dropped/pasted files — so existing
  configuration applies unchanged; with nothing configured, the image saves next to the document.
  Files are named `image.png` (or the extension matching the clipboard's image type), with `-1`,
  `-2`, ... appended if that name is already taken.

### Fixed

- Underscores and other emphasis punctuation inside inline (`$...$`) and display (`$$...$$`) math
  were still hidden as if they were live Markdown emphasis markers while editing the revealed raw
  math source, corrupting the visible text until the cursor left and KaTeX re-rendered it. Math
  ranges are now excluded from emphasis scanning the same way code ranges already are. Backslash
  sequences that are common, valid LaTeX (`\\` for a matrix row break, `\{`/`\}` for set notation)
  were similarly at risk of being misread as Markdown escape sequences; math ranges are now
  excluded there too.
- Jumping to a heading from the outline landed it at the top of the view only when scrolling
  upward to reach it; scrolling downward left it hugging the bottom instead, so where the heading
  ended up depended on where the cursor already was. Both directions now align the heading to the
  top.
- The cursor could silently jump to the wrong line whenever an external change reached the
  document while the cursor sat elsewhere — most commonly autosave running a "trim trailing
  whitespace" formatter over an earlier line while still typing further down, which is what made
  typing a trailing space at the end of a list item appear to auto-advance to the next line after
  a short delay. Applying an external update replaced the entire document text in one change,
  which CodeMirror cannot meaningfully map an existing cursor position through, so the cursor's
  raw numeric offset was clamped to the new document length instead of actually being carried
  through the edit — silently drifting forward by however many characters were removed earlier in
  the document. External updates are now applied as a single minimal, targeted change instead, so
  the cursor only moves when the edit actually touches it.
- With `loommark.keyboardEditing` on, pressing Up/Down still skipped clean over a rendered
  table/image/math block instead of entering it, even though Left/Right correctly stepped in
  character by character. CodeMirror resolves vertical motion by hit-testing pixel coordinates
  against the rendered DOM, and an opaque block widget has no per-character positions for that
  hit-test to land on, so vertical movement had nothing to do but jump clean over it regardless of
  the atomic-range settings that already governed horizontal motion. Up/Down now check whether the
  adjacent line in the direction of travel is the boundary of such a block and, if so, move the
  cursor directly to that edge so it reveals normally, the same as arriving there horizontally.

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
