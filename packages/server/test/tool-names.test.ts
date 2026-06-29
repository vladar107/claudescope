import { describe, expect, it } from 'vitest';
import { toolNamesCsv } from '../src/connectors/tool-names.js';

describe('toolNamesCsv', () => {
  it('joins tool_use names in order', () => {
    const blocks = [
      { type: 'text', text: 'hi' },
      { type: 'tool_use', name: 'Edit' },
      { type: 'tool_use', name: 'Bash' },
    ];
    expect(toolNamesCsv(blocks)).toBe('Edit,Bash');
  });
  it('returns empty string when there are no tool_use blocks', () => {
    expect(toolNamesCsv([{ type: 'text' }])).toBe('');
    expect(toolNamesCsv([])).toBe('');
  });
  it('skips tool_use blocks with a missing/empty name', () => {
    const blocks = [{ type: 'tool_use', name: '' }, { type: 'tool_use' }, { type: 'tool_use', name: 'Read' }];
    expect(toolNamesCsv(blocks)).toBe('Read');
  });
});
