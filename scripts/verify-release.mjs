import { readFile } from 'node:fs/promises';

const tag = process.argv[2];
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const expected = `v${packageJson.version}`;

if (tag !== expected) {
  console.error(`Release tag ${tag ?? '(missing)'} does not match package version ${expected}.`);
  process.exitCode = 1;
}
