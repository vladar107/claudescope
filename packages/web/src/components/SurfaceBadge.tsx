/** A small chip naming the Claude Code client a session started from. */

/** Human-friendly label for the Claude Code client a session started from. */
export function surfaceLabel(value: string): string {
  if (value === 'cli') return 'CLI';
  if (value === 'claude-desktop') return 'Desktop';
  if (value === 'claude-vscode') return 'VS Code';
  if (value.startsWith('sdk-')) return `SDK (${value.slice(4)})`;
  return value;
}

/** Chip for a non-CLI surface; renders nothing for the CLI or an absent value. */
export function SurfaceBadge({ surface }: { surface?: string }) {
  if (!surface || surface === 'cli') return null;
  const label = surfaceLabel(surface);
  return (
    <span className="tv-chip" title={`Started from ${label === surface ? surface : `the ${label} client`}`}>
      {label}
    </span>
  );
}
