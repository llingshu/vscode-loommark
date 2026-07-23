// esbuild resolves these at bundle time; TypeScript never emits them (tsconfig is
// noEmit-only), so the ambient module just needs to exist for import resolution to succeed.
declare module '*.css';
