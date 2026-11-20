import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueue } from '../../dist/data/jobs.js';

test('manual selection rejects the total byte limit before reading any PDF', async (t) => {
  const chunk = new Blob([new Uint8Array(1024 * 1024)]);
  const file = new File(['%PDF-1.7', ...Array(48).fill(chunk)], 'Large.pdf');
  const read = t.mock.method(file, 'slice');

  // Eleven files are allowed by count and each is below 50 MiB.
  await assert.rejects(
    enqueue(Array(11).fill(file), 'https://fixture.invalid/'),
    { userMessage: { key: 'batchLimit', substitutions: ['512'] } },
  );
  assert.equal(read.mock.callCount(), 0);
});
