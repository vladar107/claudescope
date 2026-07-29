import { Fragment, memo, useContext, useEffect, useRef, useState } from 'react';
import { Puzzle } from 'lucide-react';
import type { SubagentRun, ThreadBlock, ThreadItem } from '@claudescope/shared';
import { ClampedText, Collapsible, ErrorBoundary, ErrorBox, TokenChips } from '../../components';
import { formatDateTime, shortModel } from '../browse/format.js';
import { ThreadBlockView, hasRenderableContent } from './blocks.js';
import { classifySystemText, parseCommandTurn, type CommandTurn } from './text.js';
import { SessionSearchContext } from './SearchContext.js';
import { blockRevealId } from './search.js';

/** DOM id for a subagent block, used as the jump-menu / deep-link anchor. */
export function subagentAnchor(agentId: string): string {
  return `subagent-${agentId}`;
}

/** Track the current location hash (decoded), updating on hashchange. */
export function useHashTarget(): string {
  const read = () =>
    typeof window !== 'undefined' ? decodeURIComponent(window.location.hash.slice(1)) : '';
  const [hash, setHash] = useState(read);
  useEffect(() => {
    const onChange = () => setHash(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

/** Render an ordered list of turns, nesting subagent runs at their spawn point. */
export function ThreadList({
  items,
  subagentsByToolUseId,
}: {
  items: ThreadItem[];
  /** tool_use id → the subagent run(s) it spawned (Workflow fans out to many). */
  subagentsByToolUseId?: Map<string, SubagentRun[]>;
}) {
  return (
    <>
      {items.map((item) => (
        <Turn key={item.uuid} item={item} subagentsByToolUseId={subagentsByToolUseId} />
      ))}
    </>
  );
}

/**
 * Memoized: turns are immutable for the life of a session payload, so finder
 * steps and hash changes never re-render the whole list — the reveal context
 * is read in {@link RevealableBlock} below, and the hash in SubagentBlock.
 */
const Turn = memo(function Turn({
  item,
  subagentsByToolUseId,
}: {
  item: ThreadItem;
  subagentsByToolUseId?: Map<string, SubagentRun[]>;
}) {
  // Harness-injected user turns (task notifications, bash I/O, slash-command
  // output) are noise in the conversation — collapse them behind a label.
  const systemLabel = item.role === 'user' ? classifySystemTurn(item) : null;
  if (systemLabel) return <SystemTurn item={item} label={systemLabel} />;

  const roleClass = item.role === 'user' ? 'tv-turn--user' : 'tv-turn--assistant';
  const sidechainClass = item.isSidechain ? ' tv-turn--sidechain' : '';

  return (
    <article id={item.uuid} className={`tv-turn ${roleClass}${sidechainClass}`}>
      <div className="tv-turn__gutter" aria-hidden="true">
        <span className="tv-turn__role-dot" />
      </div>
      <div className="tv-turn__body">
        <header className="tv-turn__head">
          <span className="tv-turn__role">{item.role}</span>
          {item.isSidechain ? <span className="tv-turn__tag">subagent</span> : null}
          {item.model ? <span className="tv-turn__model tv-mono">{shortModel(item.model)}</span> : null}
          <span className="tv-turn__spacer" />
          {item.usage ? <TokenChips usage={item.usage} /> : null}
          {item.timestamp ? (
            <a
              className="tv-turn__time tv-muted"
              href={`#${item.uuid}`}
              title={`${formatDateTime(item.timestamp)} · click to anchor`}
            >
              {formatDateTime(item.timestamp)}
            </a>
          ) : null}
        </header>
        <div className="tv-turn__content">
          {item.blocks.map((block, i) => {
            const runs =
              block.kind === 'tool' ? subagentsByToolUseId?.get(block.id) : undefined;
            return (
              <Fragment key={i}>
                <RevealableBlock
                  blockId={blockRevealId(item.uuid, i)}
                  block={block}
                  role={item.role}
                />
                {runs?.map((run) => (
                  <SubagentBlock key={run.agentId} run={run} />
                ))}
              </Fragment>
            );
          })}
        </div>
      </div>
    </article>
  );
});

/**
 * Thin per-block wrapper that subscribes to the finder reveal context, so a
 * finder step re-renders only these wrappers — the memoized ThreadBlockView
 * bails out everywhere except the block whose `forceOpen` actually flipped.
 */
function RevealableBlock({
  blockId,
  block,
  role,
}: {
  blockId: string;
  block: ThreadBlock;
  role: ThreadItem['role'];
}) {
  const { blockIds } = useContext(SessionSearchContext);
  return (
    <div className="tv-block" data-block-id={blockId}>
      {/* A throw while rendering one block (markdown/Shiki/diff over arbitrary
          transcript content) degrades to an in-place notice; the rest of the
          thread keeps rendering. Boundary stays inside .tv-block so the finder's
          DOM queries still resolve. */}
      <ErrorBoundary
        resetKeys={[block]}
        fallback={(error) => <ErrorBox error={error} title="This block failed to render" />}
      >
        <ThreadBlockView block={block} role={role} forceOpen={blockIds.has(blockId)} />
      </ErrorBoundary>
    </div>
  );
}

/** The combined text of a turn's text blocks. */
function turnText(item: ThreadItem): string {
  return item.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('');
}

/** Return a label if this user turn is harness/system noise, else null. */
function classifySystemTurn(item: ThreadItem): string | null {
  // Only plain-text turns (no tools/attachments) qualify.
  if (item.blocks.some((b) => b.kind === 'tool' || b.kind === 'attachment')) return null;
  return classifySystemText(turnText(item));
}

/** Compact, collapsed-by-default rendering for a harness/system user turn. */
function SystemTurn({ item, label }: { item: ThreadItem; label: string }) {
  const text = turnText(item);
  // Claude Code wraps slash/bash turns in XML-style tags; parse them into clean
  // command/terminal UI. Non-command system turns (task notifications, system
  // reminders) and other agents return null → verbatim fallback below.
  const cmd = parseCommandTurn(text);
  return (
    <article id={item.uuid} className="tv-turn tv-turn--system">
      <div className="tv-turn__gutter" aria-hidden="true">
        <span className="tv-turn__role-dot" />
      </div>
      <div className="tv-turn__body">
        <Collapsible
          className="tv-collapsible--system"
          icon="⚙︎"
          title={label}
          subtitle={cmd ? commandSubtitle(cmd) : 'system / harness message'}
          headerExtra={
            item.timestamp ? (
              <a className="tv-turn__time tv-muted" href={`#${item.uuid}`}>
                {formatDateTime(item.timestamp)}
              </a>
            ) : null
          }
        >
          {cmd ? (
            <CommandBody cmd={cmd} />
          ) : (
            <ClampedText className="tv-system-turn__pre" text={text} />
          )}
        </Collapsible>
      </div>
    </article>
  );
}

/** The actual command, surfaced in the collapsed header so it's legible unexpanded. */
function commandSubtitle(cmd: CommandTurn) {
  if (cmd.kind === 'slash')
    return <span className="tv-mono">{cmd.name + (cmd.args ? ` ${cmd.args}` : '')}</span>;
  if (cmd.kind === 'bash-input') return <span className="tv-mono">{cmd.command}</span>;
  return 'system / harness message';
}

/** Structured body for a parsed command turn — prompt line(s) or terminal output. */
function CommandBody({ cmd }: { cmd: CommandTurn }) {
  switch (cmd.kind) {
    case 'slash':
      return (
        <div className="tv-cmd">
          <code className="tv-cmd__slash">
            {cmd.name}
            {cmd.args ? <span className="tv-cmd__args"> {cmd.args}</span> : null}
          </code>
        </div>
      );
    case 'bash-input':
      return (
        <div className="tv-cmd">
          <code className="tv-cmd__line">
            <span className="tv-cmd__prompt" aria-hidden="true">$ </span>
            {cmd.command}
          </code>
        </div>
      );
    case 'bash-output':
      return <CommandOutput stdout={cmd.stdout} stderr={cmd.stderr} />;
    case 'local-output':
      return <ClampedText className="tv-system-turn__pre" text={cmd.text} />;
  }
}

/** stdout/stderr of a bash turn; empty streams are omitted, stderr flagged. */
function CommandOutput({ stdout, stderr }: { stdout: string; stderr: string }) {
  const out = stdout.replace(/\s+$/, '');
  const err = stderr.replace(/\s+$/, '');
  if (!out && !err) return <p className="tv-system-turn__empty tv-muted">(no output)</p>;
  return (
    <>
      {out ? <ClampedText className="tv-system-turn__pre" text={out} /> : null}
      {err ? (
        <div className="tv-cmd__stderr">
          {out ? <span className="tv-cmd__stderr-label">stderr</span> : null}
          <ClampedText className="tv-system-turn__pre" text={err} />
        </div>
      ) : null}
    </>
  );
}

/**
 * A collapsible, indented panel rendering a subagent's full thread. Collapsed by
 * default; opens (and scrolls into view) when the location hash targets it, so
 * the "Subagents" jump menu and deep-links land on an expanded run.
 */
export function SubagentBlock({ run }: { run: SubagentRun }) {
  const anchor = subagentAnchor(run.agentId);
  const hashTarget = useHashTarget();
  const { subagentIds } = useContext(SessionSearchContext);
  const forceOpen = subagentIds.has(run.agentId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (hashTarget === anchor) {
      setOpen(true);
      ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [hashTarget, anchor]);

  const items = run.thread.filter((t) => hasRenderableContent(t.blocks));

  return (
    <div id={anchor} ref={ref} className="tv-subagent">
      <Collapsible
        className="tv-collapsible--subagent"
        open={open || forceOpen}
        onToggle={setOpen}
        icon="🧩"
        title={
          <>
            Subagent · <span className="tv-mono">{run.agentType || 'agent'}</span>
          </>
        }
        subtitle={run.description || run.slug || run.agentId}
        headerExtra={
          <span className="tv-subagent__stats">
            <span className="tv-muted">
              {run.messageCount} turns · {run.toolCallCount} tools
            </span>
            <TokenChips totalOnly total={run.totalTokens} />
          </span>
        }
      >
        <div className="tv-subagent__thread">
          {items.length === 0 ? (
            <p className="tv-muted">No renderable messages in this subagent run.</p>
          ) : (
            <ThreadList items={items} />
          )}
        </div>
      </Collapsible>
    </div>
  );
}

/**
 * A compact dropdown listing all subagents, each linking to its anchor.
 *
 * The native `<details>` is controlled so it closes the way users expect: on
 * selecting an item AND on clicking anywhere outside (native `<details>` does
 * neither, which left the menu stuck open).
 */
export function SubagentJumpMenu({ subagents }: { subagents: SubagentRun[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (subagents.length === 0) return null;
  return (
    <details ref={ref} className="tv-subagent-menu" open={open}>
      <summary
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        <Puzzle size={14} aria-hidden="true" /> Subagents{' '}
        <span className="tv-subagent-menu__count">{subagents.length}</span>
      </summary>
      <ul className="tv-subagent-menu__list">
        {subagents.map((s) => (
          <li key={s.agentId}>
            <a
              href={`#${subagentAnchor(s.agentId)}`}
              className="tv-subagent-menu__item"
              onClick={() => setOpen(false)}
            >
              <span className="tv-subagent-menu__type">{s.agentType || 'agent'}</span>
              <span className="tv-subagent-menu__desc">
                {s.description || s.slug || s.agentId}
              </span>
              {s.toolUseId ? null : <span className="tv-subagent-menu__orphan">unlinked</span>}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
