import assert from 'node:assert/strict';
import test from 'node:test';

// Kept independent of the extension bundle so the core diff contract is cheap to verify.
function singleSplice(previous, next) {
  if (previous === next) return null;
  let start = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (start < sharedLength && previous.charCodeAt(start) === next.charCodeAt(start)) start++;
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (previousEnd > start && nextEnd > start
    && previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)) {
    previousEnd--;
    nextEnd--;
  }
  return { from: start, to: previousEnd, insert: next.slice(start, nextEnd) };
}

test('finds an insertion', () => {
  assert.deepEqual(singleSplice('hello world', 'hello loom world'), {
    from: 6, to: 6, insert: 'loom ',
  });
});

test('finds a deletion', () => {
  assert.deepEqual(singleSplice('hello old world', 'hello world'), {
    from: 6, to: 10, insert: '',
  });
});

test('finds a replacement spanning multiple edits', () => {
  assert.deepEqual(singleSplice('abc 123 xyz', 'abc 456 xyz'), {
    from: 4, to: 7, insert: '456',
  });
});

test('returns null for equal text', () => {
  assert.equal(singleSplice('same', 'same'), null);
});

test('preserves unsupported markdown around an edit byte for byte', () => {
  const before = String.raw`[[Notes/Plan]]

\[intentional escape\]

<custom-block data-id="7">
original
</custom-block>`;
  const after = before.replace('original', 'edited');
  const edit = singleSplice(before, after);
  assert.deepEqual(edit, { from: before.indexOf('original'), to: before.indexOf('original') + 8, insert: 'edited' });
  assert.equal(before.slice(0, edit.from) + edit.insert + before.slice(edit.to), after);
});

test('rapid snapshots always produce the latest exact source', () => {
  let host = '# Heading\n\n';
  for (const snapshot of ['# Heading\n\na', '# Heading\n\nab', '# Heading\n\nabc']) {
    const edit = singleSplice(host, snapshot);
    assert.ok(edit);
    host = host.slice(0, edit.from) + edit.insert + host.slice(edit.to);
  }
  assert.equal(host, '# Heading\n\nabc');
});
