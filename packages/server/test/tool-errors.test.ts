import { describe, expect, it } from 'vitest';
import { MAX_TOOL_ERROR_TEXT, toolErrorText } from '../src/connectors/tool-errors.js';

describe('toolErrorText', () => {
  it('keeps only the text items of an array-form result body', () => {
    const blocks = [
      { type: 'tool_result', is_error: true, content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ] },
    ];
    expect(toolErrorText(blocks)).toBe('first\nsecond');
  });

  it('ignores results that did not fail', () => {
    expect(toolErrorText([{ type: 'tool_result', content: 'fine' }])).toBeNull();
    expect(toolErrorText([{ type: 'text' } as never])).toBeNull();
  });

  it('drops a failed result whose body is neither a string nor a block array', () => {
    // The SQL derivation yields NULL for such a body and string_agg skips it;
    // an all-unknown event therefore has no text at all, not an empty one.
    expect(toolErrorText([{ type: 'tool_result', is_error: true, content: { code: 1 } }])).toBeNull();
    expect(
      toolErrorText([
        { type: 'tool_result', is_error: true, content: { code: 1 } },
        { type: 'tool_result', is_error: true, content: 'boom' },
      ]),
    ).toBe('boom');
  });

  it('never leaves a surrogate half at the cap (it would null the cached row)', () => {
    const body = 'x'.repeat(MAX_TOOL_ERROR_TEXT - 1) + '\u{1F4A5}' + 'tail';
    const out = toolErrorText([{ type: 'tool_result', is_error: true, content: body }])!;
    expect(out).toBe('x'.repeat(MAX_TOOL_ERROR_TEXT - 1));
  });

  it('caps the joined bodies per event', () => {
    const body = 'x'.repeat(MAX_TOOL_ERROR_TEXT + 500);
    expect(toolErrorText([{ type: 'tool_result', is_error: true, content: body }])?.length).toBe(
      MAX_TOOL_ERROR_TEXT,
    );
  });
});
