#!/usr/bin/env node
/**
 * Best-effort refresh of packages/server/pricing.json from Anthropic's published
 * API pricing page. There is NO official pricing API, so this scrapes the docs
 * table — it can break if that page changes. It validates what it parses and
 * aborts (without writing) if anything looks off, so it can never produce a
 * garbage pricing file. Always review the diff afterwards.
 *
 *   node scripts/update-pricing.mjs            # fetch + rewrite pricing.json
 *   node scripts/update-pricing.mjs --dry-run  # print parsed rates, don't write
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing';
const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'packages', 'server', 'pricing.json');
const dryRun = process.argv.includes('--dry-run');

const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').trim();
const dollars = (cell) => {
  const m = cell.match(/\$?\s*([\d]+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
};

/** Parse the model-pricing table into { 'Model name': {input, cacheWrite, cacheRead, output} }. */
export function parseTable(html) {
  const rates = {};
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => stripTags(m[1]));
    if (cells.length < 6) continue;
    const name = cells[0];
    if (!/^Claude (Opus|Sonnet|Haiku)/.test(name)) continue;
    // Columns: Model | Base Input | 5m Writes | 1h Writes | Cache Hits | Output
    const [input, cacheWrite, , cacheRead, output] = [cells[1], cells[2], cells[3], cells[4], cells[5]].map(dollars);
    if ([input, cacheWrite, cacheRead, output].some((n) => n === null || Number.isNaN(n))) continue;
    rates[name.replace(/\s*\(.*$/, '').trim()] = { input, output, cacheWrite, cacheRead };
  }
  return rates;
}

/** Pick the rate for the first model name matching `re`. */
function pick(rates, re) {
  const key = Object.keys(rates).find((k) => re.test(k));
  return key ? rates[key] : null;
}

async function main() {
  process.stdout.write(`Fetching ${PRICING_URL} …\n`);
  const res = await fetch(PRICING_URL, { headers: { 'user-agent': 'claudescope-update-pricing' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching pricing page`);
  const html = await res.text();

  const rates = parseTable(html);
  const opus = pick(rates, /Opus 4\.[5-9]/) ?? pick(rates, /Opus 4\.\d/);
  const sonnet = pick(rates, /Sonnet 4/);
  const haiku = pick(rates, /Haiku 4\.5/);
  const opusOld = pick(rates, /Opus 4\.1/) ?? pick(rates, /Opus 4(\b|\.0)/);

  for (const [label, r] of [['Opus (current)', opus], ['Sonnet', sonnet], ['Haiku', haiku]]) {
    if (!r || r.input <= 0 || r.output <= 0) {
      throw new Error(`Could not parse ${label} rates from the pricing page — aborting (pricing.json unchanged).`);
    }
  }

  const config = {
    models: {
      ...(opusOld ? { 'claude-opus-4-1': opusOld, 'claude-opus-4': opusOld } : {}),
      '<synthetic>': { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    },
    families: { opus, sonnet, haiku },
    default: sonnet,
  };

  process.stdout.write('Parsed rates ($/MTok):\n');
  for (const [k, v] of Object.entries(config.families)) {
    process.stdout.write(`  ${k.padEnd(7)} in ${v.input}  out ${v.output}  write ${v.cacheWrite}  read ${v.cacheRead}\n`);
  }

  if (dryRun) {
    process.stdout.write('\n--dry-run: pricing.json NOT written.\n');
    return;
  }

  let prev = '';
  try {
    prev = readFileSync(OUT, 'utf8');
  } catch {
    /* first write */
  }
  const next = JSON.stringify(config, null, 2) + '\n';
  if (next === prev) {
    process.stdout.write('\npricing.json already up to date.\n');
    return;
  }
  writeFileSync(OUT, next);
  process.stdout.write(`\nWrote ${OUT}. Review the diff, then re-index (restart or POST /api/reindex).\n`);
}

// Only run when invoked directly (so the parser can be imported in tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`update-pricing failed: ${err.message}\n`);
    process.exit(1);
  });
}
