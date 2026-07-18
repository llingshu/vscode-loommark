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
- `mdast-util-from-markdown`: source-derived outline extraction.

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

## Progressive Syntax

The implementation uses two complementary mechanisms:

1. Lezer syntax tags provide semantic typography and code highlighting.
2. Exact source scanners identify delimiter ranges and LoomMark-specific wiki links.

Scanners are appropriate only when they are deterministic, preserve source offsets, and explicitly
exclude code ranges. They must never be used as a serializer.

## Wiki-Link Completion

The extension host finds `*.md` and `*.markdown` files, excludes generated/vendor directories, and
sends paths relative to the active document. The Webview completion source activates only after an
unclosed `[[`. Workspace create/delete/rename events refresh candidates without reopening the file.

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
