import { mkdir, rm } from 'node:fs/promises';

await Promise.all([
  rm('dist', { recursive: true, force: true }),
  rm('artifacts', { recursive: true, force: true }),
]);

await mkdir('artifacts', { recursive: true });
