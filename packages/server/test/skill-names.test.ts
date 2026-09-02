import { describe, expect, it } from 'vitest';
import { skillNamesCsv } from '../src/connectors/skill-names.js';

describe('skillNamesCsv', () => {
  it('joins the skill argument of Skill calls in order', () => {
    const blocks = [
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', name: 'Skill', input: { skill: 'claudescope:history' } },
      { type: 'tool_use', name: 'Skill', input: { skill: 'now' } },
    ];
    expect(skillNamesCsv(blocks)).toBe('claudescope:history,now');
  });

  it('skips a Skill call whose skill argument is missing or not a string', () => {
    const blocks = [
      { type: 'tool_use', name: 'Skill', input: { command: 'no skill argument' } },
      { type: 'tool_use', name: 'Skill', input: { skill: { name: 'now' } } },
      { type: 'tool_use', name: 'Skill', input: null },
      { type: 'tool_use', name: 'Skill' },
      { type: 'tool_use', name: 'Skill', input: { skill: 'review' } },
    ];
    expect(skillNamesCsv(blocks)).toBe('review');
  });

  it('ignores a Skill-named tool_result (only calls count)', () => {
    expect(skillNamesCsv([{ type: 'tool_result', name: 'Skill', input: { skill: 'now' } }])).toBe('');
  });
});
