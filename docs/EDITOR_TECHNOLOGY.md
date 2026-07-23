# Editor Technology

This document explains the implementation choices behind LoomMark's source-preserving editor.

## Why CodeMirror

Rich-text editors commonly parse Markdown into a semantic document model and later serialize that
model back to Markdown. Equivalent Markdown spellings, unknown extensions, deliberate escapes, and
blank-line layout may not survive that round trip.

LoomMark instead uses CodeMirror because its state is the source text itself. Cursor positions,
selections, composition, history, and edits all use source offsets. Rich presentation is layered on
top and can be removed without changing the document.

## Language Stack

- `@codemirror/state`: immutable editor state, transactions, ranges, and fields.
- `@codemirror/view`: DOM view, decorations, widgets, event handling, and themes.
- `@codemirror/lang-markdown`: Markdown parsing and nested code-language support.
- `@lezer/markdown`: GFM extension including strikethrough, tables, tasks, and autolinks.
- `@lezer/highlight`: semantic syntax tags.
- `@codemirror/language-data`: language descriptions loaded from fenced-code language names.
- `@codemirror/autocomplete`: wiki-link file completion.
- `@codemirror/search`: the in-editor find/replace panel, restyled to match VS Code's native
  find widget.
- `katex`: local rendering of inline and display math; no network request is made.
- `mdast-util-from-markdown`: source-derived outline extraction.

## Module Layout

The Webview is split by responsibility so each file stays reasoned-about-able in isolation:

- `webview/markdown-ranges.ts`: pure source scanners (no DOM). Every progressive-syntax range —
  fenced/inline code, tables, images, lists, math, quotes, tags, link destinations — is a plain
  function from source string to offsets, which is what `test/markdown-ranges.test.mjs` exercises
  directly through a Node-runnable esbuild bundle (`scripts/build-test-bundle.mjs`). Nested ordered
  list numbering (`loommark.orderedListStyle`) is computed here too, from `ListItemRange.level`
  alone, not the literal number in the source: a per-level counter increments while consecutive
  items stay the same `ordered` type, and resets on a real (non-blank) line between list items or
  a type change at that level — mirroring how nested `<ol>` numbering works in HTML, since there is
  no live DOM tree to lean on.
- `webview/widgets.ts`: every `WidgetType` (code toolbar, table, image, math, checkbox, bullet,
  ordered-list label, list guide rail, horizontal rule) and their DOM construction/event wiring.
- `webview/main.ts`: editor assembly, the `StateField`/`ViewPlugin` decorations that call into the
  two modules above, the host synchronization protocol, and the outline.

## List Nesting Indent Width

`LIST_INDENT_WIDTH` (`webview/markdown-ranges.ts`, currently `4`) is the number of spaces one
nesting level costs, used consistently for `ListItemRange.level`, `listGuideSegments`'s
continuation-indent threshold, and the editor's `indentUnit` (so Tab/`indentWithTab` produces
exactly this much). It must stay at 4, not 2: CommonMark only recognizes a list item as nested
once its content reaches its parent's own content column — a marker's character width plus at
least one trailing space, so 3 for `1. `, 4 for `10. ` or `1) `, and so on for more digits. A
fixed 2-space convention satisfies bullet markers (`- ` needs exactly 2) but silently falls short
for ordered ones. When it does, `@lezer/markdown` (which CodeMirror's smart Enter-continuation,
`insertNewlineContinueMarkup` from `@codemirror/lang-markdown`, relies on to find the current list
context) stops parsing that indent level as a nested `OrderedList` at all and folds it into the
parent item's `Paragraph` node instead — there is no nested list left for Enter to continue, so it
silently declines and no new line appears. 4 spaces is the smallest width that satisfies every
realistic ordered marker (three-digit numbers and below) while remaining valid, if generous, for
bullets; verified against the real parser/command pair, not just this module's own heuristics,
before choosing it.

## List Guide Connectors

`listGuideSegments()` (`webview/markdown-ranges.ts`) computes one vertical-connector segment per
list item that has content below its own line — nested children and/or a lazily-indented
continuation (a paragraph, blockquote, or fenced code block). It walks the document with a stack
of currently open ancestor items, closing an item when a shallower-or-equal item appears or a
line drops below that item's required continuation indent (its own indent plus one level), and
records a segment only if something closed later than the item's own line — a leaf with nothing
under it needs no connector. Because ancestor levels are always a contiguous run starting at 0, a
line's active levels are exactly the union of every segment containing it, with no gap-filling
needed for well-formed nesting.

`webview/main.ts`'s `listGuideField` renders this as a `ListGuideWidget` per qualifying line,
replacing that line's entire leading whitespace with one fixed-width rail per active level (rather
than trying to align with the source's actual indentation, which cannot be measured reliably in a
proportional UI font). Rail *position* in the DOM equals its nesting level, so CSS colors the
rainbow cycle with `:nth-child` alone — no per-rail inline color is computed in JS.

Unlike every other marker-hiding decoration in this file, guides never fall back to raw source
when the cursor lands on their line: there is no syntax being hidden, only blank space, so
reverting would just make the indent jump and the rails disappear right where the cursor is —
the opposite of what a "where am I" indicator is for. Each `ListGuideSegment` records its owning
item's own line (`itemLineFrom`), which `listGuideField` uses to build a `highlightedLines` set —
the cursor's own line, plus the owning line of every segment that contains the cursor position.
Only lines in that set render `.is-active` (colored); every other line within the same
connector's span (a sibling branch, unrelated continuation content one level up) stays the muted
default even though it is technically inside a segment covering that level — a segment marks
where a connector visually passes, not who counts as being on the cursor's ancestor path.

## Heading Card Mode

`headingSections()` (`webview/markdown-ranges.ts`) is the heading equivalent of
`listGuideSegments()`, but structurally simpler: a heading section is bounded purely by heading
*levels*, with no indentation-threshold logic needed. It walks the document's `headingRanges()`
with a stack, closing every open section whose level is >= the next heading's level (a same-level
heading closes all deeper ones at once, the same as a shallower list item does for list guides),
and records one section per heading spanning from its own line (the heading is the card's title,
rendered inside it, not floating above) through wherever it closes or end of document.

`webview/main.ts`'s `headingCardField` groups sections by the lines they cover, so a line deep in
a heading's subtree ends up listed under every ancestor section simultaneously. It then picks the
*shallowest* active level on that line as the "outer" one and the *deepest* as well, and computes
everything relative to `outer`. `buildHeadingCardDecorations` early-returns for `cardMode === 'off'`
and otherwise branches per mode; all three modes share `headingLevelColor(level)` (returns a
`cardColors[...]` entry if the user configured any, else `var(--loommark-guide-N)`) and
`headingBackgroundTint(level)` mixes the configured accent strength into
`--loommark-card-surface-base`, a translucent editor-colored surface. `headingBorderColor(level)`
separately mixes the accent with the active theme foreground. This keeps Card surfaces readable
over either a plain editor or an image while allowing borders to remain distinct without using
full-strength rainbow colors. The two roles are controlled by `cardBackgroundStrength` and
`cardBorderStrength`.

- `tint`: one low-opacity `linear-gradient(tint, tint)` background layer per active level, inset by
  `(level - outer.level) * HEADING_CARD_INSET_STEP` on each side, deepest level listed first in the
  CSS `background-image` list (CSS paints earlier-listed layers on top, so the narrowest band needs
  to be in front of the wider ones behind it). No borders, but the same
  `padding-left`/`padding-right` content inset as `card`, so text and nested blocks sit inside
  their own level's band instead of overhanging an ancestor's.
- `accent`: one `inset Npx 0 0 0 color` `box-shadow` per active level (a left-only rail, at full
  color, the same technique `ListGuideWidget` rails use), plus `padding-left` sized to the deepest
  level's inset plus `HEADING_CARD_CONTENT_PADDING` so content clears the innermost rail instead of
  touching it.
- `card`: the same stacked background-tint layers as `tint`, plus real side borders and content
  padding. The outer level uses the line's CSS border. Deeper levels use fixed-width gradient rails
  between dedicated `CardBoundaryWidget` instances that draw their real rounded top and bottom
  edges. When several nested sections close together, their bottom boundaries receive progressively
  larger offsets so the rounded edges remain individually visible. `padding-left`/`padding-right`
  keep content — especially nested code blocks and blockquotes — clear of the innermost boundary.
- All three modes use `margin-left`/`margin-right` equal to the outer level's own inset (`tint` and
  `card`) or just `margin-left` (`accent`, which has no right-side element), so the whole stack
  sits inset from the document edge once, rather than every level separately padding inward from a
  fixed left edge.
- Fenced-code lines cannot take the padding inset — they lay out their own 58px line-number gutter
  with `padding-left` — so in every mode they are contained by margins instead: the whole code
  panel (and its toolbar shell) moves inside the content box, and the
  `cm-loommark-card-contained-code` backdrop pseudo-element repaints that mode's layers across the
  vacated side strips (card's rails and tints as real borders plus backdrop images, tint's bare
  wash bands, accent's bars re-expressed as gradient stripes). The margins are chosen so the
  toolbar widget and the code lines share both edges exactly.

Unlike list guides, this field is a plain `StateField` reacting only to `docChanged` (and
`decorationsRefresh`, for the `loommark.cardMode` cycle command and `loommark.cardColors` changes)
— which lines belong to which heading's card never depends on cursor position.

## Decoration Types

### Mark Decorations

Mark decorations style existing text. They are used for link labels and inline-code bodies. The
text remains part of the editable document.

### Replace Decorations

Replace decorations hide delimiters such as `**`, backticks, and link destinations. They do not
delete source. The delimiter becomes visible when the caret is positioned on it.

### Line Decorations

Line decorations add heading levels, code-block surfaces, and line-number attributes. They cannot
change line text.

### Widgets

Widgets provide non-source controls. The fenced-code toolbar is a block widget containing language
and copy controls. CodeMirror requires block widgets to be supplied synchronously through a
`StateField`; ViewPlugin-provided block widgets throw a runtime `RangeError`.

The table, image, and math `StateField`s each emit both `Decoration.replace` (the widget, cursor
outside) and plain `Decoration.mark` (cursor-inside source text, e.g. the `data-loommark-href`
attribute images carry so Ctrl/Cmd + click still opens them as source). `loommark.keyboardEditing`'s
atomic-range builder only walks `.spec.widget`-bearing entries. Marking a mark decoration atomic
too would make the cursor-inside range simultaneously "here" and "cannot be entered here" the
moment a direct selection assignment (find/replace's Next button, `revealHeading`) lands inside
it — CodeMirror does not expect that combination, and one observed symptom was the search panel
appearing to vanish after clicking Next.

## Progressive Syntax

The implementation uses two complementary mechanisms:

1. Lezer syntax tags provide semantic typography and code highlighting.
2. Exact source scanners identify delimiter ranges and LoomMark-specific wiki links.

Scanners are appropriate only when they are deterministic, preserve source offsets, and explicitly
exclude code ranges. They must never be used as a serializer.

### Backslash Escapes

`isEscaped(source, position)` checks whether a character is preceded by an odd number of
backslashes and is used by every scanner that recognizes a single-character marker (emphasis,
tags, images, links). Hiding the backslash itself is a separate scanner, `escapedCharRanges`,
matched left to right over CommonMark's escapable ASCII punctuation; matching two characters per
step naturally reproduces the odd/even backslash-run pairing rule without extra bookkeeping. This
is a match-level check, not a parser: an escaped delimiter in the middle of otherwise-real emphasis
can still cause the surrounding span to fall back to plain text rather than finding the next valid
pairing, since these scanners do not resolve delimiter runs the way a full CommonMark parser does.

## Wiki-Link Completion

The extension host finds every workspace file (`**/*`, excluding `.git`, `node_modules`, and
`.vscode-test`) and sends paths relative to the active document. Markdown files drop their
`.md`/`.markdown` extension, following the Obsidian convention that a bare wiki-link target is a
note; every other file keeps its extension, both because that is what identifies the file type in
the completion list and because `openLink` only appends `.md` to an extensionless target — a
target that already has one opens exactly as named. The Webview completion source activates after
an unclosed `[[` or inside a Markdown link destination (`[label](target`). Workspace
create/delete/rename events refresh candidates without reopening the file.

Selecting a completion inserts a relative target and adds `]]` only when it is absent. Completion is
a normal CodeMirror transaction and therefore participates in undo history.

## Card Image Layer

`loommark.cardImage` renders in both the `card` and `tint` `loommark.cardMode` styles (not
`accent`, whose rails are too thin a sliver for imagery to read, and not `off`). Images use a
CodeMirror layer below document content, not repeated line backgrounds. The host resolves every
configured image through `Webview.asWebviewUri`; the Webview deterministically selects an image
from the document URI, heading level, and heading text. Layer markers derive their horizontal
bounds from the same integer inset constants as the active mode's own geometry. Vertical bounds
come from measuring the section's boundary line elements directly whenever they are mounted in the
rendered viewport: `card` mode's `-first`/`-last` lines carry real CSS margins, which CodeMirror's
height map cannot see (it measures border boxes only), so `lineBlockAt` positions drift by the
accumulated margins above them — block geometry is only a fallback for edges that are offscreen,
where the drift cannot be seen.

The two modes need different clearance, tracked by a local `bordered` flag (`cardMode === 'card'`):
`card` stays inside every drawn edge (the 2px borders, nested rails, and the shared
`cardClosingGap` clearance under a nested card's rounded bottom border), so the image never shows
outside a border line or rounded corner; `tint` has no border or closing gap to begin with — its
color bands run flush to each line's own box — so its markers use the plain per-level inset with
no border/gap compensation. Each marker owns the image, blur, overlay, and rounded clipping, so
code blocks and rendered widgets cannot split the image into visible strips.

## Fenced Code Blocks

The fence scanner records:

- opening and closing source ranges;
- content line boundaries;
- language source range;
- exact code content;
- delimiter character and length.

These offsets drive:

- syntax exclusion for other decorations;
- nested language parsing;
- code surface line classes;
- line numbers;
- visible caret colors;
- copy content;
- explicit language replacement.

Changing the language edits only the language token in the opening fence. Copying never changes the
document and omits the fence.

## Styling

Editor styling follows VS Code theme variables for the document surface and controls. Code blocks
use restrained neutral surfaces with explicit contrast. The native browser caret is styled through
`caret-color` on `.cm-content`; `.cm-cursor` rules alone are insufficient unless CodeMirror's drawn
selection extension is enabled.

CSS selectors must account for CodeMirror's generated highlight classes. Semantic token colors are
preferably defined through `HighlightStyle`, not guessed `.tok-*` class names.

## Adding A New Markdown Feature

Before implementing a feature:

1. Decide whether Lezer already exposes a semantic node/tag.
2. Define source forms, incomplete-input behavior, and code exclusions.
3. Produce decorations without dispatching transactions.
4. Keep label/content text editable whenever possible.
5. Make any source-changing command explicit and narrowly ranged.
6. Test fast input, IME, undo, external changes, and unsupported neighboring syntax.
7. Add diagnostics when runtime DOM behavior cannot be inferred from unit tests.

Do not post-process serialized Markdown. LoomMark has no serializer in its editing path.
