/**
 * Redaction for extension config shown in the UI. MCP server and hook configs
 * routinely carry credentials — API keys in args, bearer tokens in command
 * lines, webhook tokens in URL paths — and the Extensions page must never
 * echo one. Structured secret slots (`env`, `headers`) are handled upstream by
 * keeping key names only; this module covers the free-form strings that remain
 * (`command`, `args`, hook command lines, URLs).
 *
 * The rules are deliberately greedy: hiding a harmless value costs a little
 * readability, leaking a token is the one outcome that must not happen.
 */

export const REDACTED = '•••';

/** A flag or variable name that announces a credential value. */
const SECRET_NAME =
  /token|secret|passw|passphrase|pwd|api[-_]?key|apikey|auth|bearer|credential|private[-_]?key|access[-_]?key|license[-_]?key|client[-_]?id|session|cookie|signature|^(?:key|pass|pw|pat|u|p|user|username)$/i;

/** Well-known credential prefixes (OpenAI, Anthropic, GitHub, Slack, GitLab, AWS, Google, npm, Stripe, JWT). */
const KNOWN_PREFIX =
  /^(?:sk-|sk_|rk_|pk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abprs]-|glpat-|AKIA|ASIA|AIza|npm_|eyJ)/;

/**
 * A long opaque run — at least 24 chars of token alphabet mixing letters and
 * digits, or a known key prefix. Runs are cut at every non-token char, so a
 * path or package spec only matches when one of its pieces is itself opaque.
 */
function looksLikeCredential(v: string): boolean {
  if (KNOWN_PREFIX.test(v) && v.length >= 12) return true;
  return v.length >= 24 && /^[A-Za-z0-9_\-+=]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v);
}

/** A URL path segment that carries a token (Slack/Zapier-style webhook paths). */
function looksLikeTokenSegment(seg: string): boolean {
  return looksLikeCredential(seg) || (seg.length >= 16 && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg));
}

function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * `scheme://host[:port]/path` with userinfo, query, and fragment dropped and
 * token-looking path segments redacted; `undefined` when `raw` is not a URL.
 * Any scheme — `postgresql://user:pw@db/x` carries its password in userinfo.
 */
export function sanitizeUrl(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  const path = u.pathname
    .split('/')
    .map((seg) => (looksLikeTokenSegment(decodeSegment(seg)) ? REDACTED : seg))
    .join('/');
  return `${u.protocol}//${u.host}${path === '/' ? '' : path}`;
}

/** A `scheme://…` run anywhere in a token, up to a quote, bracket, or whitespace. */
const URL_RUN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`]+/g;

function isSecretFlag(arg: string): boolean {
  const m = /^-{1,2}([A-Za-z0-9][\w-]*)$/.exec(arg.replace(/^(["'])(.*)\1$/, '$2'));
  return !!m && SECRET_NAME.test(m[1]!);
}

/** One token of a command line or arg list, redacted in place. */
function redactToken(tok: string): string {
  const q = /^(["'])(.*)\1$/s.exec(tok);
  if (q) return `${q[1]}${redactToken(q[2]!)}${q[1]}`;

  const flag = /^(-{1,2}[A-Za-z0-9][\w-]*)=(.*)$/s.exec(tok);
  if (flag) {
    const name = flag[1]!.replace(/^-+/, '');
    return SECRET_NAME.test(name) ? `${flag[1]}=${REDACTED}` : `${flag[1]}=${redactToken(flag[2]!)}`;
  }

  // `NAME=value` env assignment — any value: env is where secrets are passed.
  const assign = /^([A-Za-z_][\w-]*)=(.*)$/s.exec(tok);
  if (assign) return `${assign[1]}=${REDACTED}`;

  // mysql-style glued password: `-pS3cret`.
  if (/^-p[^-\s]/.test(tok)) return `-p${REDACTED}`;

  return tok
    .replace(URL_RUN, (url) => sanitizeUrl(url) ?? REDACTED)
    .replace(/[A-Za-z0-9_\-+=]+/g, (run) => (looksLikeCredential(run) ? REDACTED : run));
}

/** An argument list with secret-bearing values replaced by {@link REDACTED}. */
export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // One arg may hold a whole header (`--header=Authorization: Bearer …`), so
    // it gets the full command-line rules, not just the single-token ones.
    out.push(i > 0 && isSecretFlag(args[i - 1]!) ? REDACTED : redactCommandLine(arg));
  }
  return out;
}

/**
 * A shell command line with secret-bearing values redacted: everything
 * {@link redactArgs} catches, plus `Authorization:`-style header values and a
 * `Bearer`/`Basic` credential, which span several whitespace-separated words.
 */
export function redactCommandLine(cmd: string): string {
  const headerSafe = cmd
    // JSON-ish `"apiKey": "…"` inside an arg or command.
    .replace(/("([\w-]+)"\s*:\s*")([^"]*)(")/g, (m, open: string, name: string, _v: string, close: string) =>
      SECRET_NAME.test(name) ? `${open}${REDACTED}${close}` : m,
    )
    .replace(/\b(Bearer|Basic|Token)\s+[^\s"']+/gi, `$1 ${REDACTED}`)
    .replace(/\b([A-Za-z][\w-]*)(\s*:\s*)(?!\s|Bearer\b|Basic\b|Token\b)([^"'\n]+)/g, (m, name: string, sep: string) =>
      SECRET_NAME.test(name) ? `${name}${sep}${REDACTED}` : m,
    );
  // Split keeping the separators, so the line's own spacing survives. A word
  // glues its quoted runs (`--token="a b"` is one word); a stray quote is kept.
  const parts = headerSafe.match(/(?:[^\s"']+|"[^"]*"|'[^']*'|["'])+|\s+/g) ?? [];
  let prevWord = '';
  return parts
    .map((part) => {
      if (/^\s+$/.test(part)) return part;
      const out = prevWord && isSecretFlag(prevWord) ? REDACTED : redactToken(part);
      prevWord = part;
      return out;
    })
    .join('');
}

/**
 * A package/plugin source spec (`npm:pkg@1.0`, `git:https://…`,
 * `git+https://user:tok@host/repo.git`, a tarball URL) with any URL in it
 * sanitized and credential-looking runs redacted.
 */
export function sanitizeSource(spec: string): string {
  return redactCommandLine(spec);
}
