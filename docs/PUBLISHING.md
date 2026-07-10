# Publishing

This document is for maintainers releasing LoomMark to GitHub and the Visual Studio
Marketplace.

## One-Time Setup

1. Confirm that the `llingshu` publisher exists in both the Visual Studio Marketplace and Open VSX.
2. Add publishing tokens as the `VSCE_PAT` and `OVSX_PAT` GitHub Actions secrets.
3. Enable GitHub private vulnerability reporting and Discussions for the repository.
4. Protect the default branch and require the CI workflow.

## Release Checklist

1. Update the version in `package.json` and `package-lock.json` together with `npm version`.
2. Move entries from `Unreleased` into a dated section in `CHANGELOG.md`.
3. Update `CITATION.cff` version and release date.
4. Run `npm ci`, `npm run check`, and `npm run package`.
5. Install `artifacts/loommark.vsix` in a clean VS Code profile and smoke-test opening, editing,
   saving, themes, settings, and reopening the source editor.
6. Commit the release metadata and create an annotated `vX.Y.Z` tag.
7. Push the tag. The release workflow validates the version, publishes the same VSIX to the Visual
   Studio Marketplace and Open VSX, creates a GitHub release, and attaches the VSIX.

Never commit a PAT, VSIX, `dist/`, or `node_modules/`.

## Manual Publishing

Build and inspect one VSIX, then publish that exact file to both registries:

```bash
npm ci
npm run package
VSCE_PAT="..." npm run publish:vscode
OVSX_PAT="..." npm run publish:openvsx
```

The equivalent direct commands are:

```bash
vsce publish --packagePath artifacts/loommark.vsix -p "<Visual Studio Marketplace token>"
ovsx publish artifacts/loommark.vsix -p "<Open VSX token>"
```

Tokens supplied through environment variables are preferable to command-line arguments because
command arguments can be retained in shell history or process listings.

As of July 2026, Visual Studio Marketplace PAT publishing still works. Microsoft has announced that
global Azure DevOps PATs will be retired on December 1, 2026; automated publishing should migrate
to Microsoft Entra ID and `vsce publish --azure-credential` before that date. Open VSX supports
`OVSX_PAT` and the `-p`/`--pat` option.
