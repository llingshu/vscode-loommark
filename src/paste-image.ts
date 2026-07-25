// Pure helpers for loommark's clipboard image paste. Dependency-free (no `vscode` import) so they
// can run under plain Node for testing, mirroring src/text.ts.

// Converts a glob pattern to a RegExp. Supports the subset markdown.copyFiles.destination
// patterns actually use in practice: `**` (any number of path segments, including none), `*`
// (anything except a path separator), `?` (a single non-separator character), and literal text
// (regex-escaped). Not a full minimatch reimplementation — brace expansion, character classes
// (`[abc]`), and extglob patterns are not supported.
function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        pattern += '(?:.*/)?';
        index += 2;
      } else {
        pattern += '.*';
        index += 1;
      }
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

// markdown.copyFiles.destination (a VS Code built-in Markdown setting loommark reuses directly,
// so pasting an image behaves the same whether or not loommark is the editor in front) maps glob
// patterns — matched against the edited document's workspace-relative path — to a destination
// folder for pasted/dropped files; the first matching entry (object key order) wins. Returns
// undefined when nothing matches, meaning "same directory as the document".
export function matchCopyDestination(
  destinations: Record<string, string>,
  relativeDocumentPath: string,
): string | undefined {
  const normalized = relativeDocumentPath.replace(/\\/g, '/');
  for (const [glob, destination] of Object.entries(destinations)) {
    if (globToRegExp(glob).test(normalized)) return destination;
  }
  return undefined;
}

const mimeExtensions: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

export function extensionForMimeType(mimeType: string): string {
  return mimeExtensions[mimeType.toLowerCase()] ?? '.png';
}

// Builds a de-duplicated file name (image.png, image-1.png, image-2.png, ...). Takes the
// existence check as an async callback rather than performing file-system I/O itself, so it stays
// unit-testable without a real workspace.
export async function nextAvailableFileName(
  exists: (name: string) => Promise<boolean>,
  baseName: string,
  extension: string,
): Promise<string> {
  const first = `${baseName}${extension}`;
  if (!(await exists(first))) return first;
  for (let index = 1; ; index++) {
    const candidate = `${baseName}-${index}${extension}`;
    if (!(await exists(candidate))) return candidate;
  }
}
