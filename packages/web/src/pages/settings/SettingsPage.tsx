/**
 * Settings page, laid out after the design mockup: header with Save Changes,
 * a Service Lifecycle tile row (controls the INDEXER — the HTTP server stays
 * terminal-only), Global Configuration | Appearance side by side, a full-width
 * Path Configuration card, and Advanced Runtime with the danger zone.
 *
 * Edits persist to ~/.claudescope/settings.json; env vars always win and
 * shadowed fields get a warning.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DollarSign,
  Moon,
  Monitor,
  Play,
  RotateCcw,
  Square,
  Sun,
  type LucideIcon,
} from 'lucide-react';
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
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor },
];

const STATE_LABELS: Record<string, string> = {
  building: 'Building index',
  indexing: 'Indexing',
  watching: 'Indexer running',
  paused: 'Indexer paused',
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

/** One big square action tile (mockup's lifecycle buttons). */
function ActionTile({
  icon: Icon,
  label,
  disabled,
  busy,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={busy ? 'tv-settings__tile is-busy' : 'tv-settings__tile'}
      disabled={disabled || busy}
      onClick={onClick}
    >
      <Icon size={20} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
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

  const { theme, setTheme } = useTheme();

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

  const setDraftValue = useCallback((key: string, v: SettingValue) => {
    setDraft((d) => ({ ...d, [key]: v }));
  }, []);

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
      const deferred = res.applied.filter((a) => !a.live).length;
      setNotice(
        deferred > 0 ? 'Saved — some changes take effect on the next start.' : 'Saved — applied live.',
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        try {
          const body = JSON.parse(err.body) as { fields?: Record<string, string> };
          setFieldErrors(body.fields ?? {});
          setNotice('Some fields are invalid.');
        } catch {
          setNotice(`Save failed: ${String(err)}`);
        }
      } else {
        setNotice(`Save failed: ${String(err)}`);
      }
    } finally {
      setSaving(false);
    }
  }, [settings, dirtyKeys, draft, seedDraft]);

  const runIndexerAction = useCallback(async (action: 'stop' | 'start' | 'restart') => {
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
  }, []);

  const syncPricing = useCallback(async () => {
    setPricingBusy(true);
    setPricingResult(null);
    try {
      const res = await api.refreshPricing();
      setPricingResult(`Price sync: ${res.modelCount} models, ${res.changed} changed.`);
    } catch (err) {
      setPricingResult(`Price sync failed: ${String(err)}`);
    } finally {
      setPricingBusy(false);
    }
  }, []);

  const rebuild = useCallback(async () => {
    setRebuildBusy(true);
    try {
      await api.rebuildIndex();
      setRebuildOpen(false);
      setNotice('Rebuilding the index — the status chip shows progress.');
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
  const building = state === 'building';

  const sources = editable.filter((s) => s.group === 'sources');
  const openBrowser = editable.find((s) => s.key === 'openBrowser');
  const interval = editable.find((s) => s.key === 'reindexIntervalMs');
  const port = settings.readOnly.find((r) => r.key === 'port');
  const home = settings.readOnly.find((r) => r.key === 'claudescopeHome');

  const intervalDraft = interval ? String(draft[interval.key] ?? baselineOf(interval)) : '15000';
  const intervalNum = Number(intervalDraft) || 0;

  return (
    <div className="tv-settings">
      {/* ---- Header: title + Save Changes (mockup top bar) ---------------- */}
      <header className="tv-settings__header">
        <h1 className="tv-page-title">Settings</h1>
        <div className="tv-settings__header-actions">
          {notice && dirtyKeys.length === 0 ? (
            <span className="tv-settings__meta">{notice}</span>
          ) : null}
          {dirtyKeys.length > 0 ? (
            <>
              <span className="tv-settings__meta">
                {dirtyKeys.length} unsaved change{dirtyKeys.length === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                className="tv-btn tv-btn--secondary"
                disabled={saving}
                onClick={discard}
              >
                Discard
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="tv-btn tv-btn--primary"
            disabled={saving || dirtyKeys.length === 0}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </header>
      {warnings.length > 0 ? (
        <div className="tv-settings__warnings">
          {warnings.map((w) => (
            <span key={`${w.key}:${w.message}`} className="tv-settings__hint--warn">
              {editable.find((s) => s.key === w.key)?.label ?? w.key}: {w.message}
            </span>
          ))}
        </div>
      ) : null}

      {/* ---- Service lifecycle (indexer) ---------------------------------- */}
      <section className="tv-settings__section">
        <div className="tv-settings__section-head">
          <div>
            <h2 className="tv-settings__section-title">Service Lifecycle</h2>
            <p className="tv-settings__desc">
              Controls background indexing — the app stays browsable while paused. The server
              itself is managed from the terminal (<code className="tv-mono">claudescope stop</code>).
            </p>
          </div>
          <span className={`tv-settings__chip tv-settings__chip--${state}`}>
            <span className="tv-settings__chip-dot" aria-hidden="true" />
            {(STATE_LABELS[state] ?? state).toUpperCase()}
          </span>
        </div>
        <div className="tv-settings__tiles">
          <ActionTile
            icon={Play}
            label="Start"
            disabled={!paused || actionBusy !== null}
            busy={actionBusy === 'start'}
            onClick={() => void runIndexerAction('start')}
          />
          <ActionTile
            icon={Square}
            label="Stop"
            disabled={paused || building || actionBusy !== null}
            busy={actionBusy === 'stop'}
            onClick={() => void runIndexerAction('stop')}
          />
          <ActionTile
            icon={RotateCcw}
            label="Restart"
            disabled={building || actionBusy !== null}
            busy={actionBusy === 'restart'}
            onClick={() => void runIndexerAction('restart')}
          />
          <ActionTile
            icon={DollarSign}
            label="Price Sync"
            busy={pricingBusy}
            onClick={() => void syncPricing()}
          />
        </div>
        <div className="tv-settings__meta">
          {system ? (
            <>
              v{system.version} · up {formatUptime(system.startedAt)}
              {system.updateAvailable && system.latestVersion ? (
                <>
                  {' · '}
                  <span className="tv-settings__hint--warn">
                    v{system.latestVersion} available:{' '}
                    <code className="tv-mono">{system.updateCommand}</code>
                  </span>
                </>
              ) : (
                ' · up to date'
              )}
            </>
          ) : null}
          {pricingResult ? <> · {pricingResult}</> : null}
          {paused ? <> · paused until resumed or restart (not persisted)</> : null}
        </div>
      </section>

      {/* ---- Global configuration | Appearance ---------------------------- */}
      <div className="tv-settings__grid2">
        <section className="tv-card tv-settings__card">
          <h2 className="tv-settings__card-title">Global Configuration</h2>
          <div className="tv-settings__row">
            <div className="tv-settings__row-head">
              <span className="tv-settings__label">Local Port</span>
              <span className="tv-settings__badge tv-settings__badge--readonly">read-only</span>
            </div>
            <input
              className="tv-settings__input tv-mono"
              value={String(port?.value ?? '')}
              disabled
            />
            <div className="tv-settings__hints">
              <span className="tv-settings__hint">
                Set with <code className="tv-mono">--port</code> or{' '}
                <code className="tv-mono">$PORT</code>
              </span>
            </div>
          </div>
          {openBrowser ? (
            <SettingRow
              setting={openBrowser}
              value={draft[openBrowser.key] ?? baselineOf(openBrowser)}
              error={fieldErrors[openBrowser.key]}
              dirty={dirtyKeys.some((d) => d.key === openBrowser.key)}
              onChange={(v) => setDraftValue(openBrowser.key, v)}
            />
          ) : null}
        </section>

        <section className="tv-card tv-settings__card">
          <h2 className="tv-settings__card-title">Appearance</h2>
          <span className="tv-settings__label">Theme Preference</span>
          <div className="tv-settings__theme-tiles" role="group" aria-label="Theme">
            {THEME_OPTIONS.map((o) => {
              const Icon = o.icon;
              return (
                <button
                  key={o.value}
                  type="button"
                  className={
                    theme === o.value
                      ? 'tv-settings__theme-tile is-active'
                      : 'tv-settings__theme-tile'
                  }
                  onClick={() => setTheme(o.value)}
                  aria-pressed={theme === o.value}
                >
                  <Icon size={20} aria-hidden="true" />
                  <span>{o.label}</span>
                </button>
              );
            })}
          </div>
          <div className="tv-settings__hints">
            <span className="tv-settings__hint">Stored per browser, not on the server.</span>
          </div>
        </section>
      </div>

      {/* ---- Path configuration ------------------------------------------- */}
      <section className="tv-card tv-settings__card">
        <div className="tv-settings__card-head">
          <h2 className="tv-settings__card-title">Path Configuration</h2>
        </div>
        <p className="tv-settings__desc">
          Agent transcript sources are read-only — Claudescope never writes to them. Path changes
          apply live; sessions from a previous directory leave the index.
        </p>
        <div className="tv-settings__row">
          <div className="tv-settings__row-head">
            <span className="tv-settings__label">Claudescope home</span>
            <span className="tv-settings__badge tv-settings__badge--readonly">read-only</span>
            <code className="tv-settings__envvar tv-mono">$CLAUDESCOPE_HOME</code>
          </div>
          <input
            className="tv-settings__input tv-mono"
            value={String(home?.value ?? '')}
            disabled
          />
        </div>
        <div className="tv-settings__grid2 tv-settings__grid2--tight">
          {sources.map((s) => (
            <SettingRow
              key={s.key}
              setting={s}
              value={draft[s.key] ?? baselineOf(s)}
              error={fieldErrors[s.key]}
              dirty={dirtyKeys.some((d) => d.key === s.key)}
              onChange={(v) => setDraftValue(s.key, v)}
            />
          ))}
        </div>
      </section>

      {/* ---- Advanced runtime + danger zone -------------------------------- */}
      <section className="tv-card tv-settings__card">
        <h2 className="tv-settings__card-title">Advanced Runtime</h2>
        <div className="tv-settings__grid2">
          <div>
            {interval ? (
              <div className="tv-settings__row">
                <div className="tv-settings__row-head">
                  <span className="tv-settings__label">Reindex Interval (ms)</span>
                  {interval.source === 'env' ? (
                    <span className="tv-settings__badge tv-settings__badge--env">env</span>
                  ) : null}
                </div>
                <div className="tv-settings__slider-row">
                  <input
                    type="range"
                    className="tv-settings__slider"
                    min={0}
                    max={60000}
                    step={1000}
                    value={Math.min(intervalNum, 60000)}
                    onChange={(e) => setDraftValue(interval.key, e.target.value)}
                    aria-label="Reindex interval"
                  />
                  <input
                    type="number"
                    className={
                      fieldErrors[interval.key]
                        ? 'tv-settings__input tv-settings__input--num tv-mono is-invalid'
                        : 'tv-settings__input tv-settings__input--num tv-mono'
                    }
                    value={intervalDraft}
                    onChange={(e) => setDraftValue(interval.key, e.target.value)}
                  />
                </div>
                <div className="tv-settings__hints">
                  {fieldErrors[interval.key] ? (
                    <span className="tv-settings__hint tv-settings__hint--error">
                      {fieldErrors[interval.key]}
                    </span>
                  ) : null}
                  <span className="tv-settings__hint">
                    How often the agent sources are scanned for new sessions. 0 disables.
                  </span>
                  {interval.source === 'env' && interval.fileValue !== undefined ? (
                    <span className="tv-settings__hint tv-settings__hint--warn">
                      Saved value is overridden by ${interval.envVar}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <div className="tv-settings__danger">
            <h3 className="tv-settings__danger-title">⚠ Danger Zone</h3>
            <p className="tv-settings__desc">
              Discards the local index (a rebuildable cache) and re-indexes every transcript.
              History is re-priced at current rates. Cannot be undone.
            </p>
            <button
              type="button"
              className="tv-btn tv-btn--danger"
              disabled={building}
              onClick={() => setRebuildOpen(true)}
            >
              Rebuild Index
            </button>
          </div>
        </div>
      </section>

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
