# LoomMark Editing Architecture

## Source fidelity contract

The Markdown text document is the only source of truth. Opening a document in
LoomMark must not normalize, format, escape, or otherwise rewrite its source.
Unsupported Markdown extensions are opaque content, not disposable syntax.

Formatting is an explicit user action. A formatter must show a diff before it
writes and must remain undoable through the VS Code workspace edit API.

## Why the current WYSIWYG core is being replaced

The current Milkdown integration serializes the entire ProseMirror document
after edits. ProseMirror stores a semantic document model rather than the
original Markdown tokens, so equivalent source forms can be lost during the
round trip. This is unsafe for wiki links, HTML, extensions, escaping, and
other user-defined workflows.

The editor must not repair serializer output after the fact. String-level
post-processing cannot preserve cursor positions or distinguish user escapes
from serializer-generated escapes.

## Target model

The replacement editor will use a source-backed block model:

```text
VS Code TextDocument
        |
  Markdown blocks + source offsets
        |
  Rendered block views
        |
  Local editor for the active block
```

CodeMirror 6 will provide text input, selection, composition, undo, and source
offsets. A Markdown parser will provide block boundaries and heading metadata.
Only the active block is editable; all other blocks are rendered views. An
edit replaces the corresponding source range and never serializes unrelated
blocks.

Wiki links, HTML, images, and unknown extensions remain source text. Their
rendered appearance is a view concern, not a reason to change the document.

## Migration constraints

1. Keep the VS Code custom editor and document synchronization contract.
2. Keep the native Explorer outline and derive it from source text.
3. Implement paragraph, heading, link, image, code block, and wiki link blocks
   before removing the Milkdown editor.
4. Preserve the existing editor behind an experimental setting only while the
   source-backed implementation is incomplete.
5. Add round-trip and source-preservation tests before making the new editor
   the default.
