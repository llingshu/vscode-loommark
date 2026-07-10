# Contributing To LoomMark

Thank you for improving LoomMark. Contributions are accepted through GitHub issues and pull
requests under the project's [Code of Conduct](CODE_OF_CONDUCT.md).

## Before You Start

- Search existing issues and pull requests before opening a duplicate.
- Use a discussion or feature request for substantial behavior or architecture changes.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Keep changes focused. Unrelated formatting or generated-file churn makes review harder.

## Development Setup

Install Node.js 20 or later, VS Code 1.95 or later, and repository dependencies:

```bash
git clone https://github.com/llingshu/vscode-loommark.git
cd loommark
npm ci
npm run check
npm run compile
```

Press `F5` in VS Code to launch the Extension Development Host. Use `npm run watch` while working
on the extension or Webview.

## Project Structure

- `src/extension.ts`: VS Code custom-editor provider and document synchronization.
- `src/protocol.ts`: typed host/Webview messages.
- `src/outline.ts`: Markdown AST extraction for the native Explorer outline.
- `src/text.ts`: minimal text replacement logic.
- `webview/`: Milkdown editor entry point and theme styles.
- `test/`: Node test runner suites.
- `DESIGN.md`: synchronization invariants and architecture roadmap.

`dist/`, `artifacts/`, and VSIX files are generated and must not be committed.

## Pull Requests

Before opening a pull request:

```bash
npm run check
npm run build
```

Describe the user-visible behavior, explain important tradeoffs, and add focused tests when logic
changes. Update `README.md`, `CHANGELOG.md`, configuration metadata, or `DESIGN.md` when their
contracts change. Include before-and-after screenshots for visible editor changes.

By submitting a contribution, you agree that it is licensed under the repository's MIT License.

## Releases

Maintainers should follow [docs/PUBLISHING.md](docs/PUBLISHING.md). Do not edit generated bundles
or release artifacts by hand.
