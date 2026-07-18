# Architecture

This document describes LoomMark's current architecture and its safety boundaries.

## System Overview

```text
VS Code TextDocument
        |
        | init / documentChanged / ack
        v
CustomTextEditorProvider  <---->  Webview protocol
        ^                           |
        | minimal WorkspaceEdit     v
        +-------------------- CodeMirror 6
                                      |
                         source-preserving decorations
```

The extension has two runtime bundles:

- `dist/extension.js` runs in the VS Code extension host.
- `dist/webview.js` runs in an isolated VS Code Webview.

`esbuild.mjs` builds both bundles. VS Code is external to the extension-host bundle; browser-side
dependencies are bundled into the Webview artifact.

## Source Of Truth

The VS Code `TextDocument` is the persistence authority. CodeMirror holds an optimistic local copy
for responsive typing, but it does not own saving, dirty state, source control integration, file
watching, or external document updates.

The editor never performs a Markdown-to-rich-model-to-Markdown round trip. CodeMirror's document is
the original source string. Rendering is produced by decorations, syntax highlighting, line
attributes, and widgets.

## Extension Host

[`src/extension.ts`](../src/extension.ts) owns:

- custom editor registration (`loommark.editor`);
- Webview creation, CSP, script/style URIs, and local resource roots;
- default editor associations;
- application of local changes through `WorkspaceEdit`;
- external document change forwarding;
- link resolution and file opening;
- workspace Markdown discovery for wiki-link completion;
- native Explorer outline registration;
- configuration and diagnostics commands.

The provider supports one custom editor per text document. The active panel and URI are retained for
outline navigation and commands.

## Webview

[`webview/main.ts`](../webview/main.ts) owns:

- the continuous CodeMirror `EditorView`;
- local source state and synchronization generations;
- Markdown and GFM language support;
- syntax highlighting and language-data loading;
- heading, emphasis, link, inline-code, and fenced-code decorations;
- wiki-link completion;
- code-block controls;
- in-editor outline rendering;
- runtime diagnostics collection.

[`webview/style.css`](../webview/style.css) owns presentation. CSS must not be used to encode
document state or cause source edits.

## Synchronization Protocol

Message types are defined in [`src/protocol.ts`](../src/protocol.ts).

### Initialization

The Webview sends `ready`. The host replies with `init`, containing:

- exact document text;
- VS Code document revision;
- synchronization delay;
- theme and outline settings;
- Webview resource base URI;
- current wiki-link file candidates.

### Local Editing

1. CodeMirror applies input immediately.
2. `localGeneration` increases.
3. Input is grouped for `loommark.syncDelay` milliseconds.
4. The Webview sends an `edit` snapshot with client and base revisions.
5. The host computes `singleSplice(current, incoming)`.
6. The host applies one minimal `WorkspaceEdit` replacement.
7. The host returns `ack` with the committed text and document revision.

Each pending client revision records the local generation at send time. An acknowledgement may only
correct local text when no newer local generation exists. This prevents stale acknowledgements from
moving the cursor or deleting rapid input.

### External Changes

The host forwards `onDidChangeTextDocument` events as `documentChanged` unless the event belongs to
the client edit currently being applied. The Webview does not apply an external snapshot while a
local timer or unacknowledged edit exists. Overlapping collaborative edits are a documented future
rebase problem.

## Decoration Model

Decorations are presentation and must never dispatch source changes.

- Heading decorations use line classes and hide ATX markers outside the marker position.
- Emphasis decorations hide paired markers while Lezer semantic tags provide typography.
- Links hide syntax ranges, retain real label text, and attach navigation metadata.
- Inline code hides matching backticks and excludes its content from other scanners.
- Fenced code adds line attributes, language parsing, a toolbar widget, line numbers, and a code
  cursor state.

Decoration ranges must be sorted with `Decoration.set(ranges, true)`. Unsorted ranges cause a
CodeMirror plugin failure. Block widgets cannot be returned from a ViewPlugin; the code toolbar is
therefore provided by a `StateField` through `EditorView.decorations.from()`.

## Parsing Boundaries

Lezer provides Markdown/GFM syntax and nested code-language parsing. Small source scanners are used
where the editor needs exact delimiter ranges or unsupported syntax such as wiki links. Scanners
must exclude fenced and inline-code ranges before producing decorations.

`mdast-util-from-markdown` is used for source-derived outline labels and offsets. It is not used to
serialize the document.

## Links And Resources

Relative links are resolved against the current document URI with `vscode.Uri.joinPath`, preserving
`file`, Remote, WSL, and other URI schemes. Relative paths must not be passed through `Uri.parse`
first because that can turn them into incorrect root-level file URIs.

Wiki links without an extension resolve to `.md`. HTTP, HTTPS, and mail links are opened externally.
The Webview receives a resource base rooted at the document directory for future image decoration.
Image preview is not yet implemented in the current editor core. Any future implementation remains
restricted by `localResourceRoots` and the Webview CSP.

## Security

- The Webview CSP denies all sources by default.
- Scripts require a per-document nonce.
- Local resources are limited to the extension distribution and document directory.
- Rendered text is built through DOM APIs or CodeMirror, not arbitrary `innerHTML` injection.
- Protocol messages are validated before use.
- Diagnostic reports are copied only after an explicit user command.

## Repository Boundaries

- `src/`: extension-host and shared protocol logic.
- `webview/`: browser editor and styles.
- `test/`: inexpensive Node regression tests.
- `scripts/`: release, cleanup, and license tooling.
- `docs/`: architecture, technology, development, and publishing documentation.
- `dist/`, `artifacts/`, `node_modules/`: generated and ignored.
