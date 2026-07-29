/**
 * Pure text helpers for the session reader (no React/DOM deps, so they're
 * cheap to unit-test).
 */

/**
 * Matches harness-injected image placeholders like `[Image #1]` or
 * `[Image: source: /…/1.png]`. The real image renders via its attachment
 * block, so these text references are redundant.
 */
export const IMAGE_MARKER_RE = /\[Image(?:\s+#\d+|:[^\]]*)\]/g;

/** Remove image placeholders and trim surrounding whitespace. */
export function stripImageMarkers(text: string): string {
  return text.replace(IMAGE_MARKER_RE, '').trim();
}

/** Reserved metadata Codex appends to assistant prose when memory was used. */
const CODEX_MEMORY_CITATION_RE =
  /\s*<oai-mem-citation>\s*<citation_entries>[\s\S]*?<\/citation_entries>\s*<rollout_ids>[\s\S]*?<\/rollout_ids>\s*<\/oai-mem-citation>\s*$/i;

/**
 * Remove a complete trailing Codex memory-citation envelope for rendered
 * Markdown. Callers retain the original block as the Source-mode value; an
 * incomplete envelope or one followed by prose is left untouched.
 */
export function stripCodexMemoryCitation(text: string): string {
  const match = CODEX_MEMORY_CITATION_RE.exec(text);
  return match ? text.slice(0, match.index).trimEnd() : text;
}

export interface CodexSessionContext {
  /** Exact recognized prefix shown inside the collapsed disclosure. */
  context: string;
  /** User-authored text following the prefix, if Codex coalesced both. */
  remainder: string;
  kind: 'instructions' | 'environment';
  includesEnvironment: boolean;
}

/**
 * Split a complete Codex startup-context prefix from any trailing user prompt.
 * Both the AGENTS wrapper and a standalone environment wrapper are recognized;
 * malformed wrappers return null so ordinary user prose is never hidden.
 */
export function splitCodexSessionContext(text: string): CodexSessionContext | null {
  const leadingWhitespace = text.search(/\S|$/);
  const source = text.slice(leadingWhitespace);
  const instructionsOpen = '<INSTRUCTIONS>';
  const instructionsClose = '</INSTRUCTIONS>';
  const environmentOpen = '<environment_context>';
  const environmentClose = '</environment_context>';

  let end = 0;
  let kind: CodexSessionContext['kind'];
  let includesEnvironment = false;

  if (source.startsWith('# AGENTS.md instructions for ')) {
    const open = source.indexOf(instructionsOpen);
    const close = source.indexOf(instructionsClose, open + instructionsOpen.length);
    if (open < 0 || close < 0) return null;
    end = close + instructionsClose.length;
    kind = 'instructions';

    const gap = source.slice(end).match(/^\s*/)?.[0].length ?? 0;
    const environmentStart = end + gap;
    if (source.startsWith(environmentOpen, environmentStart)) {
      const environmentEnd = source.indexOf(
        environmentClose,
        environmentStart + environmentOpen.length,
      );
      if (environmentEnd < 0) return null;
      end = environmentEnd + environmentClose.length;
      includesEnvironment = true;
    }
  } else if (source.startsWith(environmentOpen)) {
    const close = source.indexOf(environmentClose, environmentOpen.length);
    if (close < 0) return null;
    end = close + environmentClose.length;
    kind = 'environment';
    includesEnvironment = true;
  } else {
    return null;
  }

  const absoluteEnd = leadingWhitespace + end;
  return {
    context: text.slice(0, absoluteEnd).trimEnd(),
    remainder: text.slice(absoluteEnd).trimStart(),
    kind,
    includesEnvironment,
  };
}

/** Leading tags that mark a user turn as harness/system-injected, not a person. */
export const SYSTEM_TURN_TAGS: { tag: string; label: string }[] = [
  { tag: '<task-notification>', label: 'Task notification' },
  { tag: '<system-reminder>', label: 'System reminder' },
  { tag: '<local-command-stdout>', label: 'Command output' },
  { tag: '<local-command-stderr>', label: 'Command output' },
  { tag: '<local-command-caveat>', label: 'Command note' },
  { tag: '<command-name>', label: 'Slash command' },
  { tag: '<command-message>', label: 'Slash command' },
  { tag: '<bash-input>', label: 'Bash input' },
  { tag: '<bash-stdout>', label: 'Bash output' },
  { tag: '<bash-stderr>', label: 'Bash output' },
];

/** Return a label if the text begins with a known system tag, else null. */
export function classifySystemText(text: string): string | null {
  const trimmed = text.trimStart();
  const hit = SYSTEM_TURN_TAGS.find((t) => trimmed.startsWith(t.tag));
  return hit ? hit.label : null;
}

/**
 * ANSI/CSI escape sequences (SGR colours, cursor moves). Claude Code's
 * `local-command-stdout` carries raw escapes like `[1m…[22m` that
 * would otherwise render as garbage.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Strip ANSI escape sequences from terminal text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Inner content of the first `<tag>…</tag>` (newline-tolerant), or null. */
function tagContent(text: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m?.[1] ?? null;
}

/**
 * A harness command turn parsed out of Claude Code's XML-style markers. These
 * tags are Claude-Code-specific; other agents record shell/slash interactions
 * as real tool calls or plain text, so {@link parseCommandTurn} returns null
 * for everything else and the turn falls back to verbatim rendering.
 */
export type CommandTurn =
  | { kind: 'slash'; name: string; args: string }
  | { kind: 'bash-input'; command: string }
  | { kind: 'bash-output'; stdout: string; stderr: string }
  | { kind: 'local-output'; text: string };

/**
 * Parse a harness command turn from its leading tag. Returns null when the text
 * isn't a recognized command turn (or a tag is truncated/unclosed), so callers
 * cleanly fall through to plain rendering.
 */
export function parseCommandTurn(text: string): CommandTurn | null {
  const trimmed = text.trimStart();

  // Slash command: <command-name>/foo</command-name> … <command-args>…</command-args>.
  // The redundant <command-message> (the name sans slash) is intentionally dropped.
  if (trimmed.startsWith('<command-name>')) {
    const name = tagContent(trimmed, 'command-name');
    if (name === null) return null;
    return { kind: 'slash', name: name.trim(), args: (tagContent(trimmed, 'command-args') ?? '').trim() };
  }

  // Bash input: a single <bash-input>…</bash-input> turn (the `!` shell escape).
  if (trimmed.startsWith('<bash-input>')) {
    const command = tagContent(trimmed, 'bash-input');
    if (command === null) return null;
    return { kind: 'bash-input', command: command.trim() };
  }

  // Bash output: <bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>; either may be empty.
  if (trimmed.startsWith('<bash-stdout>') || trimmed.startsWith('<bash-stderr>')) {
    return {
      kind: 'bash-output',
      stdout: stripAnsi(tagContent(trimmed, 'bash-stdout') ?? ''),
      stderr: stripAnsi(tagContent(trimmed, 'bash-stderr') ?? ''),
    };
  }

  // Local command output (slash-command stdout/stderr/caveat), often ANSI-coloured.
  if (
    trimmed.startsWith('<local-command-stdout>') ||
    trimmed.startsWith('<local-command-stderr>') ||
    trimmed.startsWith('<local-command-caveat>')
  ) {
    const inner =
      tagContent(trimmed, 'local-command-stdout') ??
      tagContent(trimmed, 'local-command-stderr') ??
      tagContent(trimmed, 'local-command-caveat');
    if (inner === null) return null;
    return { kind: 'local-output', text: stripAnsi(inner).trim() };
  }

  return null;
}
