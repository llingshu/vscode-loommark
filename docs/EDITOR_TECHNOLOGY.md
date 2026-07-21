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
  ordered-list label, horizontal rule) and their DOM construction/event wiring.
- `webview/main.ts`: editor assembly, the `StateField`/`ViewPlugin` decorations that call into the
  two modules above, the host synchronization protocol, and the outline.

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
target that already has one opens exactly as named. The Webview completion source activates only
after an unclosed `[[`. Workspace create/delete/rename events refresh candidates without reopening
the file.

Selecting a completion inserts a relative target and adds `]]` only when it is absent. Completion is
a normal CodeMirror transaction and therefore participates in undo history.

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
