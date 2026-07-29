/**
 * Redaction for output that may leave the machine — the Markdown export's
 * "redact" toggle and the MCP/CLI `--redact` flag.
 *
 * The Windows cases are the reason this file exists: `HOME_RE` required a forward
 * slash after the drive-letter branch (`[A-Z]:\\Users` followed by `\/`), so
 * `C:\Users\alice\src` never matched and the username survived into exported
 * transcripts. Deliberately conservative overall — false positives matter more
 * than exhaustive coverage — so the secret cases pin the prefixes that ARE
 * claimed, not every token format in existence.
 */

import { describe, expect, it } from 'vitest';
import { redactText } from '../src/redact.js';

describe('home directory paths', () => {
  it('masks POSIX home paths, keeping the trailing path', () => {
    expect(redactText('/Users/alice/src/app/index.ts')).toBe('~/src/app/index.ts');
    expect(redactText('/home/alice/src/app')).toBe('~/src/app');
  });

  it('masks Windows home paths (both separators, either drive-letter case)', () => {
    expect(redactText('C:\\Users\\alice\\src\\app')).toBe('~\\src\\app');
    expect(redactText('c:\\Users\\alice\\src')).toBe('~\\src');
    expect(redactText('D:/Users/alice/src')).toBe('~/src');
  });

  it('drops the username, which is the point', () => {
    for (const p of ['/Users/alice/x', '/home/alice/x', 'C:\\Users\\alice\\x']) {
      expect(redactText(p)).not.toContain('alice');
    }
  });

  it('masks every occurrence in a longer body', () => {
    const out = redactText('read C:\\Users\\bob\\a.ts then /Users/bob/b.ts');
    expect(out).toBe('read ~\\a.ts then ~/b.ts');
  });

  it('leaves paths with no home segment alone', () => {
    expect(redactText('/usr/local/bin/node')).toBe('/usr/local/bin/node');
    expect(redactText('/opt/tools/bin')).toBe('/opt/tools/bin');
  });

  it('also masks a home-looking segment mid-path', () => {
    // Not anchored to the start, so `<prefix>/Users/<name>` collapses too. That
    // is right for the case it exists for — a mounted or backed-up home, e.g.
    // /mnt/backup/Users/alice — and it means an unrelated directory that happens
    // to be called `Users` is over-redacted. Documented rather than tightened:
    // for a redaction helper, over-masking is the safe direction to err in.
    expect(redactText('/mnt/backup/Users/alice/src')).toBe('/mnt/backup~/src');
    expect(redactText('/var/Users/notahome')).toBe('/var~');
  });
});

describe('secrets', () => {
  it('masks the prefix-anchored patterns it claims to cover', () => {
    const cases: [string, string][] = [
      ['sk-abcdefghijklmnopqrstuvwx', '«redacted-key»'],
      ['ghp_abcdefghijklmnopqrstuvwxyz12', '«redacted-token»'],
      ['github_pat_abcdefghijklmnopqrstuv', '«redacted-token»'],
      ['AKIAIOSFODNN7EXAMPLE', '«redacted-aws-key»'],
      ['xoxb-1234567890-abcdefg', '«redacted-slack-token»'],
    ];
    for (const [secret, marker] of cases) {
      const out = redactText(`token: ${secret}`);
      expect(out).toContain(marker);
      expect(out).not.toContain(secret);
    }
  });

  it('masks a private key block including its body', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nsecretline\n-----END RSA PRIVATE KEY-----';
    const out = redactText(key);
    expect(out).toBe('«redacted-private-key»');
    expect(out).not.toContain('secretline');
  });

  it('keeps a Bearer scheme readable while masking the credential', () => {
    expect(redactText('Authorization: Bearer abcdefghijklmnopqrst')).toBe(
      'Authorization: Bearer «redacted»',
    );
  });

  it('does not fire on short lookalikes (false positives are worse here)', () => {
    expect(redactText('sk-short')).toBe('sk-short');
    expect(redactText('the task is done')).toBe('the task is done');
  });
});
