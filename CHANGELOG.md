# Changelog

All notable changes to LoomMark are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/llingshu/vscode-loommark/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/llingshu/vscode-loommark/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/llingshu/vscode-loommark/releases/tag/v0.1.0
