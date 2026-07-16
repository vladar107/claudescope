import { describe, expect, it } from 'vitest';
import { extractImage } from '../src/components/image.js';

const urlBlock = (url: string) => ({ type: 'image', source: { type: 'url', url } });

describe('extractImage', () => {
  it('builds a data URI from a base64 source', () => {
    expect(
      extractImage({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }),
    ).toBe('data:image/png;base64,abc');
  });

  it('keeps data:image/ and same-origin url sources', () => {
    expect(extractImage(urlBlock('data:image/png;base64,abc'))).toBe('data:image/png;base64,abc');
    expect(extractImage(urlBlock('/api/img/1'))).toBe('/api/img/1');
  });

  it('rejects remote and schemed url sources (transcripts are untrusted)', () => {
    expect(extractImage(urlBlock('http://attacker.example/x.png'))).toBeNull();
    expect(extractImage(urlBlock('https://attacker.example/x.png'))).toBeNull();
    expect(extractImage(urlBlock('//attacker.example/x.png'))).toBeNull();
    expect(extractImage(urlBlock('file:///etc/passwd'))).toBeNull();
    expect(extractImage(urlBlock('data:text/html,<script>'))).toBeNull();
  });

  it('returns null for non-image or malformed blocks', () => {
    expect(extractImage(null)).toBeNull();
    expect(extractImage({ type: 'text', text: 'hi' })).toBeNull();
    expect(extractImage({ type: 'image', source: { type: 'base64' } })).toBeNull();
  });
});
