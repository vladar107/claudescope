/** A small chip flagging a session that ran on a local model provider (no API cost). */

export function LocalBadge() {
  return (
    <span className="tv-chip tv-chip--local" title="Ran on a local model provider — no API cost">
      local
    </span>
  );
}
