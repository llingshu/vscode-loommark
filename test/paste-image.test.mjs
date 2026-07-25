import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extensionForMimeType,
  matchCopyDestination,
  nextAvailableFileName,
} from '../out/test/paste-image.mjs';

test('matches a **/* glob against any document path', () => {
  const destination = matchCopyDestination({ '**/*': 'doc_images/' }, 'notes/project.md');
  assert.equal(destination, 'doc_images/');
});

test('first matching entry wins, in object key order', () => {
  const destinations = { 'docs/**': 'docs-assets/', '**/*': 'doc_images/' };
  assert.equal(matchCopyDestination(destinations, 'docs/guide.md'), 'docs-assets/');
  assert.equal(matchCopyDestination(destinations, 'notes/project.md'), 'doc_images/');
});

test('returns undefined when nothing matches', () => {
  const destination = matchCopyDestination({ 'docs/**': 'docs-assets/' }, 'notes/project.md');
  assert.equal(destination, undefined);
});

test('normalizes backslashes before matching', () => {
  const destination = matchCopyDestination({ 'docs/**': 'docs-assets/' }, 'docs\\guide.md');
  assert.equal(destination, 'docs-assets/');
});

test('a single * does not cross a path separator', () => {
  const destinations = { '*.md': 'top-level/' };
  assert.equal(matchCopyDestination(destinations, 'project.md'), 'top-level/');
  assert.equal(matchCopyDestination(destinations, 'notes/project.md'), undefined);
});

test('maps common image MIME types to an extension', () => {
  assert.equal(extensionForMimeType('image/png'), '.png');
  assert.equal(extensionForMimeType('image/jpeg'), '.jpg');
  assert.equal(extensionForMimeType('IMAGE/GIF'), '.gif');
});

test('falls back to .png for an unrecognized MIME type', () => {
  assert.equal(extensionForMimeType('application/octet-stream'), '.png');
});

test('picks the base name when nothing exists yet', async () => {
  const name = await nextAvailableFileName(async () => false, 'image', '.png');
  assert.equal(name, 'image.png');
});

test('appends an incrementing suffix until a free name is found', async () => {
  const existing = new Set(['image.png', 'image-1.png', 'image-2.png']);
  const name = await nextAvailableFileName(async (candidate) => existing.has(candidate), 'image', '.png');
  assert.equal(name, 'image-3.png');
});
