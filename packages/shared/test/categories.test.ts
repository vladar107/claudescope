import { describe, expect, it } from 'vitest';
import { toolCategory } from '../src/categories.js';

describe('toolCategory', () => {
  it('maps canonical file ops to Edit', () => {
    for (const n of ['Edit', 'Write', 'MultiEdit', 'apply_patch']) {
      expect(toolCategory(n)).toBe('Edit');
    }
  });
  it('maps reads, searches, shells, web, subagents', () => {
    expect(toolCategory('Read')).toBe('Read');
    expect(toolCategory('Grep')).toBe('Search');
    expect(toolCategory('Glob')).toBe('Search');
    expect(toolCategory('Bash')).toBe('Shell');
    expect(toolCategory('shell')).toBe('Shell'); // codex raw name
    expect(toolCategory('WebFetch')).toBe('Web');
    expect(toolCategory('Task')).toBe('Subagent');
  });
  it('is case-insensitive and trims', () => {
    expect(toolCategory('  bash ')).toBe('Shell');
  });
  it('falls back to Other for unknown / empty / mcp names', () => {
    expect(toolCategory('TodoWrite')).toBe('Other');
    expect(toolCategory('mcp__foo__bar')).toBe('Other');
    expect(toolCategory('')).toBe('Other');
  });
});
