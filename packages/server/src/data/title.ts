/**
 * Fallback session-title cleaning.
 *
 * Codex and pi sessions store no title (and a Claude session may never have
 * been auto-titled), so the indexer falls back to the session's first user
 * message (see `first_user` in `index.ts`). That raw message is often markup or
 * a tool-injected blob — a leading `# AGENTS.md instructions for /…` heading, a
 * `<INSTRUCTIONS>…</INSTRUCTIONS>` wrapper, system reminders — which makes an
 * ugly, leaky title.
 *
 * {@link cleanFallbackTitle} turns that raw text into a short, honest title. It
 * is PURE and DETERMINISTIC — no time or randomness — so the derived title is
 * stable across re-index (the index is a derived cache; same input → same
 * output keeps it from churning).
 */

/**
 * Max length of a fallback title before it's clipped with an ellipsis. Matches
 * the original SQL `left(…, 80)` clip so titles don't get longer than before.
 */
export const TITLE_MAX_LENGTH = 80;

const ELLIPSIS = '…';

/**
 * Lines that are clearly system/tool-injected rather than user prose. We skip
 * them when picking the "first real line" so the title reflects what the user
 * actually asked, not the harness scaffolding wrapped around it.
 */
const INJECTED_LINE = [
  /^#{1,6}\s*\S.*\b(instructions?|guidelines?)\b.*\bfor\b/i, // "# AGENTS.md instructions for /…"
  /^<\/?[a-z][\w-]*>?$/i, // a lone XML-ish tag line: <INSTRUCTIONS> or </INSTRUCTIONS>
  /^<(system|system-reminder|instructions?|context|user[_-]instructions?)\b/i, // opening blob tag
  /^(system reminder|caveat|important):/i, // common injected preambles
];

/** A line worth showing: has at least one word character once tags are gone. */
function isProse(line: string): boolean {
  if (line.length === 0) return false;
  if (INJECTED_LINE.some((re) => re.test(line))) return false;
  return /[A-Za-z0-9]/.test(stripTags(line));
}

/** Strip XML/HTML-ish tags (`<INSTRUCTIONS>`, `</foo>`) from a single line. */
function stripTags(line: string): string {
  return line.replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi, ' ');
}

/**
 * Strip leading markdown structure from a line: heading markers (`#`, `##`, …),
 * blockquote (`>`), list bullets (`-`, `*`, `+`, `1.`), and surrounding
 * emphasis (`*`, `_`, `` ` ``, `~`).
 */
function stripMarkdown(line: string): string {
  let s = line.replace(/^\s*#{1,6}\s+/, ''); // ATX heading
  s = s.replace(/^\s*>+\s*/, ''); // blockquote
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''); // list bullet / ordered marker
  s = s.replace(/^[*_~`]+/, '').replace(/[*_~`]+$/, ''); // surrounding emphasis
  return s.trim();
}

/**
 * Clean a raw first-user-message into a short fallback title.
 *
 * Strips markdown headings/emphasis and XML-ish wrapper tags, prefers the first
 * line of real user prose (skipping injected instruction blobs), collapses all
 * whitespace to single spaces, and clips to {@link TITLE_MAX_LENGTH} with an
 * ellipsis. Returns `''` when nothing usable remains.
 */
export function cleanFallbackTitle(raw: string | null | undefined): string {
  if (!raw) return '';

  // Pick the first prose line; fall back to the first non-empty line so a
  // single-line blob still yields something rather than nothing.
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const chosen =
    lines.find((l) => isProse(l)) ?? lines.find((l) => l.length > 0) ?? '';

  // Strip tags first (so emphasis stripping sees real text), then markdown
  // structure, then collapse remaining whitespace to single spaces.
  const text = stripMarkdown(stripTags(chosen)).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return '';

  if (text.length <= TITLE_MAX_LENGTH) return text;
  // Clip to the limit (ellipsis included), trimming a dangling space so we
  // don't render "word …".
  return text.slice(0, TITLE_MAX_LENGTH - ELLIPSIS.length).trimEnd() + ELLIPSIS;
}
