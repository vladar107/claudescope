/**
 * Line-diff primitives re-exported from the shared package (they moved there so
 * the server can diff edits for Markdown output too). Web-only rendering
 * constants stay here.
 */

export { diffStats, extOf, lineDiff } from '@claudescope/shared';
export type { DiffLine, DiffLineType } from '@claudescope/shared';

/** Skip syntax highlighting for payloads larger than this (Shiki gets slow). */
export const MAX_HIGHLIGHT = 60_000;
