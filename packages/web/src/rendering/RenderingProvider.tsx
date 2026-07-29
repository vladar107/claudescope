/**
 * Browser-local transcript rendering preferences. These choices affect only
 * presentation, so they intentionally live beside the theme preference rather
 * than in the daemon's settings.json contract.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export const RENDERING_STORAGE_KEY = 'claudescope-rendering';
const STORAGE_VERSION = 1;

interface StoredRenderingPreferences {
  version: typeof STORAGE_VERSION;
  markdownEnabled: boolean;
  mermaidEnabled: boolean;
}

export interface RenderingPreferences {
  markdownEnabled: boolean;
  mermaidEnabled: boolean;
  setMarkdownEnabled: (enabled: boolean) => void;
  setMermaidEnabled: (enabled: boolean) => void;
}

const DEFAULTS: StoredRenderingPreferences = {
  version: STORAGE_VERSION,
  markdownEnabled: true,
  mermaidEnabled: true,
};

const RenderingContext = createContext<RenderingPreferences | null>(null);

/** Read and validate the persisted value; corrupt/old data safely resets. */
function readStored(): StoredRenderingPreferences {
  try {
    const raw = localStorage.getItem(RENDERING_STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as Partial<StoredRenderingPreferences>).version === STORAGE_VERSION &&
      typeof (parsed as Partial<StoredRenderingPreferences>).markdownEnabled === 'boolean' &&
      typeof (parsed as Partial<StoredRenderingPreferences>).mermaidEnabled === 'boolean'
    ) {
      return parsed as StoredRenderingPreferences;
    }
  } catch {
    /* localStorage may be unavailable or contain invalid JSON */
  }
  return DEFAULTS;
}

function persist(preferences: StoredRenderingPreferences): void {
  try {
    localStorage.setItem(RENDERING_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    /* persistence failure must not make the transcript unreadable */
  }
}

export function RenderingProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<StoredRenderingPreferences>(readStored);

  useEffect(() => persist(preferences), [preferences]);

  const update = (patch: Partial<StoredRenderingPreferences>) => {
    setPreferences((current) => {
      const next: StoredRenderingPreferences = { ...current, ...patch, version: STORAGE_VERSION };
      return next;
    });
  };

  return (
    <RenderingContext.Provider
      value={{
        markdownEnabled: preferences.markdownEnabled,
        mermaidEnabled: preferences.mermaidEnabled,
        setMarkdownEnabled: (enabled) => update({ markdownEnabled: enabled }),
        setMermaidEnabled: (enabled) => update({ mermaidEnabled: enabled }),
      }}
    >
      {children}
    </RenderingContext.Provider>
  );
}

export function useRenderingPreferences(): RenderingPreferences {
  const context = useContext(RenderingContext);
  if (!context) throw new Error('useRenderingPreferences must be used within RenderingProvider');
  return context;
}
