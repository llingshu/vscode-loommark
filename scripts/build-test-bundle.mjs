import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['webview/markdown-ranges.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: 'out/test/markdown-ranges.mjs',
  logLevel: 'warning',
});

await esbuild.build({
  entryPoints: ['src/paste-image.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: 'out/test/paste-image.mjs',
  logLevel: 'warning',
});
