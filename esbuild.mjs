import * as esbuild from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const require = createRequire(import.meta.url);
const common = {
  bundle: true,
  minify: production,
  metafile: production,
  sourcemap: !production,
  logLevel: 'info',
};

// @llingshu/loommark-core is consumed via `npm link` (it isn't published yet — see the kernel's
// own README), a symlink to a *separate* project directory with its own independent node_modules.
// Its peerDependencies declaration only guarantees a single shared copy under a real registry
// install; a symlinked, unrelated project root has no shared ancestor for npm to hoist a
// single copy into, so without this alias this project's own @codemirror/state (used directly
// by webview/annotation-extension.ts) and the copy loommark-core resolves internally (from its
// own devDependencies) would be two separate instances — exactly the reference-identity bug
// peerDependencies exists to prevent. Aliasing forces every import of these specifiers,
// regardless of which file does the importing, to resolve to this project's own single copy.
const singleInstance = [
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/lang-markdown',
  '@codemirror/language',
  '@codemirror/language-data',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/highlight',
  '@lezer/markdown',
];
const alias = Object.fromEntries(singleInstance.map((name) => [name, require.resolve(name)]));

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    alias,
    // The webview runs in Chromium, which always prefers woff2; drop legacy font fallbacks.
    loader: { '.woff': 'empty', '.woff2': 'dataurl', '.ttf': 'empty' },
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching extension and webview bundles...');
} else {
  const results = await Promise.all(builds.map((options) => esbuild.build(options)));
  if (production) {
    const inputs = Object.assign({}, ...results.map((result) => result.metafile?.inputs ?? {}));
    await writeFile('dist/metafile.json', JSON.stringify({ inputs }, null, 2));
  }
}
