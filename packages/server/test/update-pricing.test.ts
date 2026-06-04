import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations.
import { parseTable } from '../../../scripts/update-pricing.mjs';

// A trimmed copy of Anthropic's pricing table shape (Model | Base Input |
// 5m Writes | 1h Writes | Cache Hits | Output).
const HTML = `
<table>
  <tr><th>Model</th><th>Base Input</th><th>5m Cache Writes</th><th>1h Cache Writes</th><th>Cache Hits</th><th>Output</th></tr>
  <tr><td>Claude Opus 4.8</td><td>$5 / MTok</td><td>$6.25 / MTok</td><td>$10 / MTok</td><td>$0.50 / MTok</td><td>$25 / MTok</td></tr>
  <tr><td>Claude Sonnet 4.6</td><td>$3 / MTok</td><td>$3.75 / MTok</td><td>$6 / MTok</td><td>$0.30 / MTok</td><td>$15 / MTok</td></tr>
  <tr><td>Claude Haiku 4.5</td><td>$1 / MTok</td><td>$1.25 / MTok</td><td>$2 / MTok</td><td>$0.10 / MTok</td><td>$5 / MTok</td></tr>
  <tr><td>Claude Opus 4.1 (<a>deprecated</a>)</td><td>$15 / MTok</td><td>$18.75 / MTok</td><td>$30 / MTok</td><td>$1.50 / MTok</td><td>$75 / MTok</td></tr>
</table>`;

describe('update-pricing parseTable', () => {
  const rates = parseTable(HTML);

  it('extracts input/output/cacheWrite(5m)/cacheRead per model', () => {
    expect(rates['Claude Opus 4.8']).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(rates['Claude Sonnet 4.6']).toEqual({ input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 });
    expect(rates['Claude Haiku 4.5']).toEqual({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 });
  });

  it('uses the 5-minute write column (not 1-hour) and strips the deprecated note', () => {
    // Opus 4.1 row: 5m write = 18.75 (not the 1h $30), name trimmed of "(deprecated)".
    expect(rates['Claude Opus 4.1']).toEqual({ input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 });
  });

  it('ignores the header row and any non-Claude rows', () => {
    expect(rates.Model).toBeUndefined();
    expect(Object.keys(rates).every((k) => k.startsWith('Claude '))).toBe(true);
  });
});
