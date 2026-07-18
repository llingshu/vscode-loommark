# LoomMark Design Principles

Detailed implementation documentation lives in:

- [Architecture](docs/ARCHITECTURE.md)
- [Editor technology](docs/EDITOR_TECHNOLOGY.md)
- [Development and debugging](docs/DEVELOPMENT.md)

## Product Principles

1. Markdown source is the product, not an implementation detail.
2. Opening a document must never rewrite it.
3. Rendering is reversible presentation layered over source text.
4. Unsupported syntax remains editable and unchanged.
5. Source-changing actions are explicit, narrow, undoable, and attributable to the user.
6. Fast typing, IME, cursor stability, and recovery take priority over decoration.
7. VS Code remains responsible for persistence, dirty state, filesystem events, and source control.

## Non-Goals

LoomMark is not a document format, a Markdown normalizer, a remote collaboration service, or a
rich-text model that merely exports Markdown. It does not attempt to make all Markdown dialects
identical.

## Decision Record

The original Milkdown/ProseMirror implementation was replaced because semantic-model serialization
could normalize or lose source constructs such as wiki links, escapes, HTML, and blank lines.

The current editor uses one continuous CodeMirror document. An earlier prototype used independent
editors per Markdown block; it was rejected because keyboard navigation was poor and rapid input
could race with block reconstruction. Progressive rendering must not fragment the input model.
