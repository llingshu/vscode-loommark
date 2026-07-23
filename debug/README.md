# Webview harness

`harness.html` loads the real `dist/webview.js`/`dist/webview.css` bundle in a plain browser tab,
outside VS Code. It stubs `acquireVsCodeApi()` so that when the bundle sends its `ready` message,
the stub answers with a synthetic `init` message — no extension host, no real document, but the
same CodeMirror editor, same decorations, same CSS.

## Build then open

```bash
node esbuild.mjs        # produces dist/webview.js and dist/webview.css
```

Then just open `debug/harness.html` in any regular browser (double-click it, or `xdg-open
debug/harness.html`). It behaves like a live preview: edit text, click things, resize the window.
Nothing you do reaches a real file — `edit`/`openLink`/`diagnostics` messages the bundle sends are
silently dropped since there's no host listening on the other end.

Query params change what the stubbed `init` message contains, without touching the file:

- `?mode=tint|accent|card|off` — sets `loommark.cardMode` (default `card`).
- `?images=1` — turns on `loommark.cardImage` with a small solid-color placeholder image, so you
  can check Card-image geometry without wiring up real files.
- `?bg=none` / `?border=none` — empties `loommark.cardBackgroundColors` / `loommark.cardBorderColors`
  respectively, to check the "no color" path.
- `?colors=a,b,c` — overrides both color lists with a comma-separated custom list.

Example: `debug/harness.html?mode=tint&images=1`, or `debug/harness.html?mode=card&border=none` to
check a background-only Card with no border.

Re-run `node esbuild.mjs` after any `webview/` change and reload the tab — there's no watch mode
wired up here, just a plain static file.

## Automated / headless measurement

Add `&measure=1` to the URL. After the editor settles (~600ms) it appends a `<pre
id="measure-results">` with `getBoundingClientRect()` output for the elements that tend to drift
(code toolbar, code lines, card first/last lines, card boundary widgets, card images, `.cm-content`).
Handy for scripting exact-pixel regression checks instead of eyeballing screenshots.

If you have a headless Chromium around (Playwright's cache works: `~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell`,
or a system `chromium`/`chromium-browser`), you can dump and grep it from the CLI:

```bash
chromium --headless --disable-gpu --no-sandbox --window-size=1000,2400 \
  --virtual-time-budget=5000 --dump-dom \
  "file://$PWD/debug/harness.html?mode=card&images=1&measure=1" > /tmp/dom.html

python3 -c "
import re
html = open('/tmp/dom.html').read()
m = re.search(r'<pre id=\"measure-results\">(.*?)</pre>', html, re.S)
print(m.group(1) if m else 'NOT FOUND')
"
```

Or screenshot it instead of measuring:

```bash
chromium --headless --disable-gpu --no-sandbox --window-size=1000,900 \
  --virtual-time-budget=5000 --screenshot=/tmp/shot.png \
  "file://$PWD/debug/harness.html?mode=accent"
```

This is how the tint/accent code-alignment and Card-image overflow bugs in this directory's
screenshots were tracked down: the harness makes it possible to get exact numbers for a decoration
whose position is computed inline in `webview/main.ts`, instead of guessing from a screenshot.
