# Changelog

All notable changes to LoomMark are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-20

### Added

- KaTeX-rendered math: inline `$...$` and display `$$...$$` blocks follow the same
  render-outside/edit-inside model as other progressive syntax. Currency-like text stays plain.
- `loommark.keyboardEditing` lets the text cursor enter rendered images, tables, and math with the
  keyboard for mouse-free editing. Disabled by default, so these render as atomic click-to-edit
  regions.
- `loommark.tableStyle` adds a booktabs-style `ruled` three-line table appearance alongside the
  default bordered `grid`.

### Changed

- The in-editor outline is now an overlay drawer opened from a floating control in the top-right
  corner. It no longer reserves a column, so the editor uses the full width until the outline is
  opened. Escape closes it.

### Fixed

- The third-party license generator now matches package license filenames case-insensitively, so
  regeneration on case-sensitive filesystems no longer drops license texts.

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

[Unreleased]: https://github.com/llingshu/vscode-loommark/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/llingshu/vscode-loommark/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/llingshu/vscode-loommark/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/llingshu/vscode-loommark/releases/tag/v0.1.0
