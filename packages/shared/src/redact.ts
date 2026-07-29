/**
 * Conservative masking of home-dir paths and likely secrets, for output that
 * may leave the machine (Markdown export, MCP/CLI output). Prefix-anchored
 * patterns only — avoiding false positives matters more than catching every
 * exotic token format.
 */

/**
 * Home-dir paths -> `~` (drops the username segment too).
 *
 * The separator is a character class, not a literal `/`: the Windows branch
 * previously required a forward slash after `C:\Users`, so `C:\Users\alice\src`
 * never matched and the username survived into exported Markdown and MCP output.
 * Drive letters are matched case-insensitively (`c:\` is as common as `C:\`), and
 * `C:/Users/...` is covered too since some tools normalize separators.
 */
const HOME_RE = /(?:\/Users|\/home|[A-Za-z]:[\\/]Users)[\\/][^/\\\s"'`)]+/g;
// Conservative, prefix-anchored secret patterns (avoid false positives).
const SECRET_RES: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{16,}/g, '«redacted-key»'],
  [/(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/g, '«redacted-token»'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '«redacted-token»'],
  [/AKIA[0-9A-Z]{16}/g, '«redacted-aws-key»'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '«redacted-slack-token»'],
  [/Bearer\s+[A-Za-z0-9._-]{16,}/g, 'Bearer «redacted»'],
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '«redacted-private-key»'],
];

/** Mask home paths and likely secrets in a string. */
export function redactText(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_RES) out = out.replace(re, rep);
  out = out.replace(HOME_RE, '~');
  return out;
}
