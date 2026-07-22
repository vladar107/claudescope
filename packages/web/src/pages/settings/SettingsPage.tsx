/**
 * Settings page. Lifecycle controls target the INDEXER (the background
 * reindex engine) — the HTTP server is never stopped from here (terminal
 * only). Edits persist to ~/.claudescope/settings.json; env vars always win
 * and shadowed fields get a warning badge.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Moon, Monitor, Sun, type LucideIcon } from 'lucide-react';
import type {
  EditableSetting,
  IndexerStatus,
  SettingValue,
  SettingsResponse,
  SettingsUpdateResponse,
  SystemInfoResponse,
} from '@claudescope/shared';
import { ApiError, api } from '../../api/client.js';
import { ConfirmDialog, ErrorBox, Spinner } from '../../components';
import { useServerStatus } from '../../status/StatusProvider.js';
import { useTheme, type ThemeChoice } from '../../theme/ThemeProvider.js';
import { SettingRow } from './SettingRow.js';
import './settings.css';

const THEME_OPTIONS: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

/** Segmented System / Light / Dark theme control (client-side, per browser). */
function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="tv-theme-toggle" role="group" aria-label="Theme">
      {THEME_OPTIONS.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            className={theme === o.value ? 'tv-theme-toggle__btn is-active' : 'tv-theme-toggle__btn'}
            onClick={() => setTheme(o.value)}
            title={`${o.label} theme`}
            aria-pressed={theme === o.value}
          >
            <Icon size={15} aria-hidden="true" />
            <span className="tv-settings__theme-label">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const STATE_LABELS: Record<string, string> = {
  building: 'Building index…',
  indexing: 'Indexing now…',
  watching: 'Watching for changes',
  paused: 'Paused',
};

/** Baseline a draft compares against: the saved value, else what's in effect. */
function baselineOf(s: EditableSetting): SettingValue {
  return s.fileValue !== undefined ? s.fileValue : s.effective;
}

function formatUptime(startedAt: string): string {
  const ms = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function SettingsPage() {
  const health = useServerStatus();

  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [system, setSystem] = useState<SystemInfoResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState<Record<string, SettingValue>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<SettingsUpdateResponse['warnings']>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Fresh action response wins over the (up to 10s stale) health poll until
  // the next poll lands.
  const [localIndexer, setLocalIndexer] = useState<IndexerStatus | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  useEffect(() => setLocalIndexer(null), [health.indexer]);

  const [pricingBusy, setPricingBusy] = useState(false);
  const [pricingResult, setPricingResult] = useState<string | null>(null);

  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [rebuildBusy, setRebuildBusy] = useState(false);

  const seedDraft = useCallback((res: SettingsResponse) => {
    const next: Record<string, SettingValue> = {};
    for (const s of res.editable) next[s.key] = baselineOf(s);
    setDraft(next);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.getSettings(controller.signal), api.systemInfo(controller.signal)])
      .then(([s, sys]) => {
        setSettings(s);
        setSystem(sys);
        seedDraft(s);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setLoadError(String(err));
      });
    return () => controller.abort();
  }, [seedDraft]);

  const editable = settings?.editable ?? [];
  const dirtyKeys = useMemo(
    // String-compare: number inputs hold strings mid-edit, so '15000' vs
    // 15000 must not count as dirty when the user reverts an edit.
    () =>
      editable.filter(
        (s) => draft[s.key] !== undefined && String(draft[s.key]) !== String(baselineOf(s)),
      ),
    [editable, draft],
  );

  const discard = useCallback(() => {
    if (settings) seedDraft(settings);
    setFieldErrors({});
    setNotice(null);
  }, [settings, seedDraft]);

  const save = useCallback(async () => {
    if (!settings || dirtyKeys.length === 0) return;
    const patch: Record<string, SettingValue | null> = {};
    const clientErrors: Record<string, string> = {};
    for (const s of dirtyKeys) {
      const v = draft[s.key];
      if (s.type === 'path') {
        const trimmed = String(v).trim();
        patch[s.key] = trimmed === '' ? null : trimmed; // empty clears to default
      } else if (s.type === 'number') {
        const str = String(v).trim();
        if (str === '') {
          patch[s.key] = null; // empty clears to default, same as paths
        } else {
          const n = Number(str);
          if (!Number.isFinite(n)) clientErrors[s.key] = 'must be a number';
          else patch[s.key] = n;
        }
      } else {
        patch[s.key] = v === true;
      }
    }
    setFieldErrors(clientErrors);
    if (Object.keys(clientErrors).length > 0) return;

    setSaving(true);
    setNotice(null);
    try {
      const res = await api.updateSettings(patch);
      setSettings(res.settings);
      seedDraft(res.settings);
      setWarnings(res.warnings);
      setFieldErrors({});
      const liveCount = res.applied.filter((a) => a.live).length;
      const deferred = res.applied.length - liveCount;
      setNotice(
        deferred > 0
          ? `Saved. ${liveCount} setting${liveCount === 1 ? '' : 's'} applied live; ${deferred} take${deferred === 1 ? 's' : ''} effect on the next start.`
          : 'Saved — changes applied live.',
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        try {
          const body = JSON.parse(err.body) as { fields?: Record<string, string> };
          setFieldErrors(body.fields ?? {});
        } catch {
          setLoadError(String(err));
        }
      } else {
        setNotice(`Save failed: ${String(err)}`);
      }
    } finally {
      setSaving(false);
    }
  }, [settings, dirtyKeys, draft, seedDraft]);

  const runIndexerAction = useCallback(
    async (action: 'stop' | 'start' | 'restart') => {
      setActionBusy(action);
      try {
        const fn =
          action === 'stop'
            ? api.indexerStop
            : action === 'start'
              ? api.indexerStart
              : api.indexerRestart;
        setLocalIndexer(await fn());
      } catch (err) {
        setNotice(`Indexer ${action} failed: ${String(err)}`);
      } finally {
        setActionBusy(null);
      }
    },
    [],
  );

  const syncPricing = useCallback(async () => {
    setPricingBusy(true);
    setPricingResult(null);
    try {
      const res = await api.refreshPricing();
      setPricingResult(
        `${res.modelCount} models fetched, ${res.changed} changed. New rates apply to newly indexed events.`,
      );
    } catch (err) {
      setPricingResult(`Refresh failed: ${String(err)}`);
    } finally {
      setPricingBusy(false);
    }
  }, []);

  const rebuild = useCallback(async () => {
    setRebuildBusy(true);
    try {
      await api.rebuildIndex();
      setRebuildOpen(false);
      setNotice('Rebuilding the index — progress shows in the status card.');
    } catch (err) {
      setNotice(`Rebuild failed to start: ${String(err)}`);
    } finally {
      setRebuildBusy(false);
    }
  }, []);

  if (loadError) return <ErrorBox title="Failed to load settings" error={loadError} />;
  if (!settings) return <Spinner label="Loading settings…" />;

  const indexer = localIndexer ?? health.indexer;
  const state = indexer?.state ?? 'building';
  const paused = indexer?.paused ?? false;
  const groups = {
    sources: editable.filter((s) => s.group === 'sources'),
    indexing: editable.filter((s) => s.group === 'indexing'),
    startup: editable.filter((s) => s.group === 'startup'),
  };

  return (
    <div className="tv-settings">
      <h1 className="tv-page-title">Settings</h1>

      {/* ---- Status & indexing lifecycle -------------------------------- */}
      <section className="tv-card tv-settings__card">
        <div className="tv-settings__card-head">
          <h2 className="tv-settings__card-title">Indexing</h2>
          <span className={`tv-settings__state tv-settings__state--${state}`}>
            {STATE_LABELS[state] ?? state}
            {indexer?.intervalMs === 0 && state === 'watching' ? ' (auto-reindex off)' : ''}
          </span>
        </div>
        <p className="tv-settings__desc">
          Start, stop, or restart the background indexer. While paused, Claudescope stays fully
          browsable on the existing index — it just stops picking up new sessions until resumed or
          the app is restarted. The server itself is stopped from the terminal
          (<code className="tv-mono">claudescope stop</code>).
        </p>
        <div className="tv-settings__actions">
          {paused ? (
            <button
              type="button"
              className="tv-btn tv-btn--primary"
              disabled={actionBusy !== null}
              onClick={() => void runIndexerAction('start')}
            >
              {actionBusy === 'start' ? 'Starting…' : 'Start indexing'}
            </button>
          ) : (
            <button
              type="button"
              className="tv-btn tv-btn--secondary"
              disabled={actionBusy !== null || state === 'building'}
              onClick={() => void runIndexerAction('stop')}
            >
              {actionBusy === 'stop' ? 'Stopping…' : 'Stop indexing'}
            </button>
          )}
          <button
            type="button"
            className="tv-btn tv-btn--secondary"
            disabled={actionBusy !== null || state === 'building'}
            onClick={() => void runIndexerAction('restart')}
          >
            {actionBusy === 'restart' ? 'Restarting…' : 'Restart indexing'}
          </button>
          {system ? (
            <span className="tv-settings__meta">
              v{system.version} · up {formatUptime(system.startedAt)}
              {localIndexer?.lastPassAt
                ? ` · last pass ${new Date(localIndexer.lastPassAt).toLocaleTimeString()}`
                : ''}
            </span>
          ) : null}
        </div>
        {paused ? (
          <p className="tv-settings__hint tv-settings__hint--warn">
            Paused until resumed here or the process restarts — the pause is not persisted.
          </p>
        ) : null}
      </section>

      {/* ---- Appearance -------------------------------------------------- */}
      <section className="tv-card tv-settings__card">
        <h2 className="tv-settings__card-title">Appearance</h2>
        <p className="tv-settings__desc">Theme is stored per browser, not on the server.</p>
        <ThemeToggle />
      </section>

      {/* ---- Sources ------------------------------------------------------ */}
      <section className="tv-card tv-settings__card">
        <div className="tv-settings__card-head">
          <h2 className="tv-settings__card-title">Agent sources</h2>
          <span className="tv-settings__badge tv-settings__badge--readonly">READ-ONLY sources</span>
        </div>
        <p className="tv-settings__desc">
          Where each agent's transcripts are read from. Claudescope never writes to these
          directories. Changes apply live — the index re-scans immediately; sessions from a
          previous directory disappear from the index.
        </p>
        {groups.sources.map((s) => (
          <SettingRow
            key={s.key}
            setting={s}
            value={draft[s.key] ?? baselineOf(s)}
            error={fieldErrors[s.key]}
            dirty={dirtyKeys.some((d) => d.key === s.key)}
            onChange={(v) => setDraft((d) => ({ ...d, [s.key]: v }))}
          />
        ))}
      </section>

      {/* ---- Indexing & startup ------------------------------------------ */}
      <section className="tv-card tv-settings__card">
        <h2 className="tv-settings__card-title">Indexing &amp; startup</h2>
        {[...groups.indexing, ...groups.startup].map((s) => (
          <SettingRow
            key={s.key}
            setting={s}
            value={draft[s.key] ?? baselineOf(s)}
            error={fieldErrors[s.key]}
            dirty={dirtyKeys.some((d) => d.key === s.key)}
            onChange={(v) => setDraft((d) => ({ ...d, [s.key]: v }))}
          />
        ))}
        <p className="tv-settings__hint">Auto-reindex interval: 0 disables the background scan.</p>
      </section>

      {/* ---- Read-only paths ---------------------------------------------- */}
      <section className="tv-card tv-settings__card">
        <h2 className="tv-settings__card-title">App paths (read-only)</h2>
        <p className="tv-settings__desc">
          Infrastructure fixed at boot — change via env vars or CLI flags.
        </p>
        <table className="tv-settings__table">
          <tbody>
            {settings.readOnly.map((r) => (
              <tr key={r.key}>
                <td className="tv-settings__table-label">{r.label}</td>
                <td className="tv-mono">{r.value}</td>
                <td>
                  <span className={`tv-settings__badge tv-settings__badge--${r.source}`}>
                    {r.source === 'env' ? 'env' : 'default'}
                  </span>
                  {r.envVar ? <code className="tv-settings__envvar tv-mono">${r.envVar}</code> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ---- Pricing ------------------------------------------------------- */}
      <section className="tv-card tv-settings__card">
        <h2 className="tv-settings__card-title">Pricing</h2>
        <p className="tv-settings__desc">
          Rates auto-refresh daily from LiteLLM; costs are local estimates. Edit{' '}
          <code className="tv-mono">~/.claudescope/pricing.json</code> to override rates. Pricing
          applies to newly indexed events — rebuild the index to re-price history.
        </p>
        <div className="tv-settings__actions">
          <button
            type="button"
            className="tv-btn tv-btn--secondary"
            disabled={pricingBusy}
            onClick={() => void syncPricing()}
          >
            {pricingBusy ? 'Syncing…' : 'Sync prices now'}
          </button>
          {pricingResult ? <span className="tv-settings__meta">{pricingResult}</span> : null}
        </div>
      </section>

      {/* ---- Update -------------------------------------------------------- */}
      {system ? (
        <section className="tv-card tv-settings__card">
          <h2 className="tv-settings__card-title">Update</h2>
          {system.updateAvailable && system.latestVersion ? (
            <>
              <p className="tv-settings__desc">
                v{system.version} → <strong>v{system.latestVersion}</strong> is available. Updates
                run from the terminal ({system.installMethod} install):
              </p>
              <code className="tv-settings__cmd tv-mono">{system.updateCommand}</code>
            </>
          ) : (
            <p className="tv-settings__desc">
              v{system.version} — up to date
              {system.latestVersion ? ` (latest: v${system.latestVersion})` : ''}.
            </p>
          )}
        </section>
      ) : null}

      {/* ---- Danger zone ---------------------------------------------------- */}
      <section className="tv-card tv-settings__card tv-settings__card--danger">
        <h2 className="tv-settings__card-title">Danger zone</h2>
        <p className="tv-settings__desc">
          The index is a derived cache — rebuilding discards the local DuckDB file and re-indexes
          every transcript from your sources. History is re-priced at current rates. The app stays
          usable and shows build progress.
        </p>
        <div className="tv-settings__actions">
          <button
            type="button"
            className="tv-btn tv-btn--danger"
            disabled={state === 'building'}
            onClick={() => setRebuildOpen(true)}
          >
            Rebuild index
          </button>
        </div>
      </section>

      {/* ---- Sticky save bar ------------------------------------------------ */}
      {dirtyKeys.length > 0 || notice || warnings.length > 0 ? (
        <div className="tv-settings__savebar">
          <div className="tv-settings__savebar-text">
            {dirtyKeys.length > 0 ? (
              <span>
                {dirtyKeys.length} unsaved change{dirtyKeys.length === 1 ? '' : 's'}
              </span>
            ) : notice ? (
              <span>{notice}</span>
            ) : null}
            {warnings.map((w) => (
              <span key={`${w.key}:${w.message}`} className="tv-settings__hint--warn">
                {settings.editable.find((s) => s.key === w.key)?.label ?? w.key}: {w.message}
              </span>
            ))}
          </div>
          {dirtyKeys.length > 0 ? (
            <div className="tv-settings__savebar-actions">
              <button
                type="button"
                className="tv-btn tv-btn--secondary"
                disabled={saving}
                onClick={discard}
              >
                Discard
              </button>
              <button
                type="button"
                className="tv-btn tv-btn--primary"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {rebuildOpen ? (
        <ConfirmDialog
          title="Rebuild the index?"
          confirmLabel="Rebuild index"
          danger
          busy={rebuildBusy}
          onConfirm={() => void rebuild()}
          onCancel={() => setRebuildOpen(false)}
        >
          This discards the local index and rebuilds it from your transcripts. Nothing in your
          agent directories is touched. History is re-priced at current rates. Browsing is limited
          until the rebuild finishes.
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
