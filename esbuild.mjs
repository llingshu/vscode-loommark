import * as esbuild from 'esbuild';
import { writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const common = {
  bundle: true,
  minify: production,
  metafile: production,
  sourcemap: !production,
  logLevel: 'info',
};
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
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
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
