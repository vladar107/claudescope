/**
 * One editable setting row: label, input (per type), provenance badge, and
 * contextual hints — env-override warning, missing-path notice, per-field
 * validation error, "applies on next start" for non-live settings.
 */

import type { EditableSetting, SettingValue } from '@claudescope/shared';

export interface SettingRowProps {
  setting: EditableSetting;
  /** Current draft value (may be a string mid-edit for number fields). */
  value: SettingValue;
  /** Server-side validation error for this key, if the last save failed. */
  error?: string;
  dirty: boolean;
  onChange: (value: SettingValue) => void;
}

/** Provenance chip: where the effective value comes from. */
function SourceBadge({ setting }: { setting: EditableSetting }) {
  const label =
    setting.source === 'env' ? 'env' : setting.source === 'file' ? 'saved' : 'default';
  return <span className={`tv-settings__badge tv-settings__badge--${setting.source}`}>{label}</span>;
}

export function SettingRow({ setting, value, error, dirty, onChange }: SettingRowProps) {
  const envShadowed = setting.source === 'env' && setting.fileValue !== undefined;
  const inputId = `tv-setting-${setting.key}`;

  return (
    <div className={dirty ? 'tv-settings__row is-dirty' : 'tv-settings__row'}>
      <div className="tv-settings__row-head">
        <label className="tv-settings__label" htmlFor={inputId}>
          {setting.label}
        </label>
        <SourceBadge setting={setting} />
        {setting.envVar ? (
          <code className="tv-settings__envvar tv-mono" title={`Overriding env var`}>
            ${setting.envVar}
          </code>
        ) : null}
      </div>

      {setting.type === 'boolean' ? (
        <label className="tv-settings__toggle">
          <input
            id={inputId}
            type="checkbox"
            className="tv-switch__input"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="tv-switch" aria-hidden="true" />
          <span className="tv-settings__toggle-text">{value === true ? 'On' : 'Off'}</span>
        </label>
      ) : (
        <input
          id={inputId}
          type={setting.type === 'number' ? 'number' : 'text'}
          className={
            error
              ? 'tv-settings__input tv-mono is-invalid'
              : 'tv-settings__input tv-mono'
          }
          value={String(value)}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      <div className="tv-settings__hints">
        {error ? <span className="tv-settings__hint tv-settings__hint--error">{error}</span> : null}
        {envShadowed ? (
          <span className="tv-settings__hint tv-settings__hint--warn">
            Saved value is overridden by ${setting.envVar} in this process
          </span>
        ) : null}
        {setting.type === 'path' && setting.exists === false ? (
          <span className="tv-settings__hint tv-settings__hint--warn">
            Path not found — this source indexes nothing
          </span>
        ) : null}
        {!setting.live ? (
          <span className="tv-settings__hint">
            Applies at the next <code className="tv-mono">claudescope start</code>
          </span>
        ) : null}
      </div>
    </div>
  );
}
