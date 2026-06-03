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
