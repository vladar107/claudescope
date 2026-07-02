/**
 * Unit tests for the shared symlink-safe image resolver — the containment
 * semantics every connector relies on: real-path escape refusal (traversal and
 * symlinks), within-root symlinks allowed, extension gate, size cap.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_IMAGE_BYTES, resolveImageWithin } from '../src/connectors/safe-image.js';

const work = mkdtempSync(join(tmpdir(), 'claudescope-safeimg-'));
const root = join(work, 'root');
const outside = join(work, 'outside');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(() => {
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'ok.png'), PNG);
  writeFileSync(join(root, 'target.png'), PNG);
  writeFileSync(join(outside, 'secret.png'), PNG);
  writeFileSync(join(root, 'notes.txt'), 'not an image');
  symlinkSync(join(outside, 'secret.png'), join(root, 'escape.png')); // escapes root
  symlinkSync(join(root, 'target.png'), join(root, 'alias.png')); // stays inside root
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('resolveImageWithin', () => {
  it('inlines a regular image inside the root', () => {
    const block = resolveImageWithin(root, join(root, 'ok.png'));
    expect(block).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
    });
  });

  it('refuses a symlink whose target escapes the root', () => {
    expect(resolveImageWithin(root, join(root, 'escape.png'))).toBeNull();
  });

  it('refuses a traversal path resolving outside the root', () => {
    expect(resolveImageWithin(root, join(root, '..', 'outside', 'secret.png'))).toBeNull();
  });

  it('allows a symlink whose target stays inside the root', () => {
    expect(resolveImageWithin(root, join(root, 'alias.png'))).not.toBeNull();
  });

  it('refuses a non-image extension and a missing file', () => {
    expect(resolveImageWithin(root, join(root, 'notes.txt'))).toBeNull();
    expect(resolveImageWithin(root, join(root, 'gone.png'))).toBeNull();
  });

  it('refuses an oversized image', () => {
    writeFileSync(join(root, 'big.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    expect(resolveImageWithin(root, join(root, 'big.png'))).toBeNull();
  });
});
