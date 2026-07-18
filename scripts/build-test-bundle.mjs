import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['webview/markdown-ranges.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: 'out/test/markdown-ranges.mjs',
  logLevel: 'warning',
});
