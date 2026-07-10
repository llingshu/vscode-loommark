import { access, readFile, writeFile } from 'node:fs/promises';
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

async function firstExisting(root, names) {
  for (const name of names) {
    const candidate = path.join(root, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next conventional license filename.
    }
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
