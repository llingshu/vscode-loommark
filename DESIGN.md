# LoomMark design

## Invariants

1. The VS Code `TextDocument` is the persistence authority.
2. The Webview updates optimistically; round trips never gate visible typing.
3. Host acknowledgements never replace the ProseMirror document.
4. External changes update the editor without being emitted back as user edits.
5. Unsupported syntax must eventually round-trip byte-for-byte through raw nodes.

## Synchronization protocol

The host initializes the Webview with the document text and its VS Code version. Local Milkdown
updates are grouped by a configurable delay and sent with client and base revisions. The host
computes a single minimal splice and applies it through `WorkspaceEdit`, preserving VS Code dirty
state and file lifecycle behavior. It then acknowledges the client revision.

An unrelated `onDidChangeTextDocument` event is considered external and is pushed to the Webview.
The Webview suppresses its Markdown listener while applying that update, preventing feedback loops.

## Phase 2: lossless source model

The snapshot splice is deliberately isolated behind a small function. Phase 2 replaces it with:

```text
Markdown bytes -> lossless CST -> source-bound ProseMirror nodes
                                  |
changed nodes -> local serializer + unchanged original slices -> TextEdits
```

Each bound node carries a stable identifier, original source range, original source slice, and
semantic fingerprint. Unchanged nodes reuse their source slices. Unknown blocks and inline syntax
become raw nodes rather than disappearing during serialization.

## Phase 2: revision rebase

Pending local edits are retained until acknowledged. When an external change arrives on a newer
base revision, non-overlapping source edits are rebased. Overlapping changes are reparsed at the
nearest stable block boundary. A full replacement is the final recovery path, not normal behavior.

## Undo policy

VS Code is the authority for committed history. Composition and continuous typing are grouped into
one synchronization batch. Before undo/redo, pending input must be flushed, then the VS Code command
is executed and its resulting document event is mapped back into ProseMirror. ProseMirror history
is used only for transactions that have not yet crossed the host boundary.
