import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const metadata = JSON.parse(await readFile('dist/metafile.json', 'utf8'));
const packageRoots = new Set();

for (const input of Object.keys(metadata.inputs)) {
  const parts = input.split('/');
  const nodeModules = parts.lastIndexOf('node_modules');
  if (nodeModules < 0 || !parts[nodeModules + 1]) continue;
  const nameLength = parts[nodeModules + 1].startsWith('@') ? 2 : 1;
  packageRoots.add(parts.slice(0, nodeModules + 1 + nameLength).join('/'));
}

// Package license files are not consistently cased (e.g. `license` vs `LICENSE`). A
// case-sensitive filesystem (Linux, including GitHub Actions runners) silently misses
// lowercase filenames if matched by exact case, so this compares names case-insensitively.
async function firstExisting(root, names) {
  let entries;
  try {
    entries = await readdir(root);
  } catch {
    return undefined;
  }
  const byLowerCase = new Map(entries.map((entry) => [entry.toLowerCase(), entry]));
  for (const name of names) {
    const match = byLowerCase.get(name.toLowerCase());
    if (match) return path.join(root, match);
  }
  return undefined;
}

const packages = [];
for (const root of [...packageRoots].sort()) {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const licensePath = await firstExisting(root, [
    'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING', 'COPYING.md',
  ]);
  packages.push({
    name: manifest.name,
    version: manifest.version,
    license: typeof manifest.license === 'string' ? manifest.license : 'UNKNOWN',
    repository: typeof manifest.repository === 'string'
      ? manifest.repository
      : manifest.repository?.url,
    licenseText: licensePath ? await readFile(licensePath, 'utf8') : undefined,
  });
}

const lines = [
  'THIRD-PARTY SOFTWARE LICENSES',
  '================================',
  '',
  'This file is generated from the dependencies incorporated into the production bundles.',
  'Do not edit it by hand; run `npm run build && npm run licenses`.',
  '',
];

for (const dependency of packages) {
  lines.push(`${dependency.name}@${dependency.version}`);
  lines.push(`Declared license: ${dependency.license}`);
  if (dependency.repository) lines.push(`Source: ${dependency.repository}`);
  lines.push('');
  lines.push(dependency.licenseText?.trim() ?? 'No standalone license file was found in the package.');
  lines.push('', '--------------------------------------------------------------------------------', '');
}

await writeFile('THIRD_PARTY_LICENSES.txt', `${lines.join('\n')}\n`);
console.log(`Recorded licenses for ${packages.length} bundled packages.`);
