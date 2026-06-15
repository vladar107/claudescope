import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import type { SourceInfo } from '@claudescope/shared';
import { api } from './api/client.js';
import { useTheme, type ThemeChoice } from './theme/ThemeProvider.js';
import { BrowsePage } from './pages/browse/BrowsePage.js';
import { SessionListPage } from './pages/browse/SessionList.js';
import { SessionPage } from './pages/session/SessionPage.js';
import { SearchPage } from './pages/search/SearchPage.js';
import { AnalyticsPage } from './pages/analytics/AnalyticsPage.js';
import { MemoryPage } from './pages/memory/MemoryPage.js';
import { AgentMemoryPage } from './pages/memory/AgentMemoryPage.js';
import { AgentProjectMemoryPage } from './pages/memory/AgentProjectMemoryPage.js';
import { ProjectMemoryPage } from './pages/memory/ProjectMemoryPage.js';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** `end` for routes that should only match exactly (the index route). */
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Browse', icon: '📁', end: true },
  { to: '/memory', label: 'Memory', icon: '🧠' },
  { to: '/search', label: 'Search', icon: '🔍' },
  { to: '/analytics', label: 'Analytics', icon: '📊' },
];

const THEME_OPTIONS: { value: ThemeChoice; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: '🖥' },
  { value: 'light', label: 'Light', icon: '☀' },
  { value: 'dark', label: 'Dark', icon: '🌙' },
];

/** Segmented System / Light / Dark theme control. */
function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="tv-theme-toggle" role="group" aria-label="Theme">
      {THEME_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={theme === o.value ? 'tv-theme-toggle__btn is-active' : 'tv-theme-toggle__btn'}
          onClick={() => setTheme(o.value)}
          title={`${o.label} theme`}
          aria-pressed={theme === o.value}
        >
          <span aria-hidden="true">{o.icon}</span>
        </button>
      ))}
    </div>
  );
}

/** Left navigation sidebar. */
function Sidebar() {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    api
      .sources(controller.signal)
      .then(setSources)
      .catch(() => {
        /* footer is best-effort */
      });
    return () => controller.abort();
  }, []);

  return (
    <nav className="tv-nav">
      <NavLink to="/" className="tv-nav__brand" end>
        Claudescope
      </NavLink>
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => (isActive ? 'tv-nav__link is-active' : 'tv-nav__link')}
        >
          <span aria-hidden="true">{item.icon}</span>
          {item.label}
        </NavLink>
      ))}
      <div className="tv-nav__spacer" />
      <ThemeToggle />
      <div className="tv-nav__footer">
        <span className="tv-nav__footer-label">Read-only sources</span>
        {sources.map((s) => (
          <span key={s.id} className="tv-nav__source tv-mono" title={`${s.label} · ${s.path}`}>
            {s.path}
          </span>
        ))}
      </div>
    </nav>
  );
}

/** Application shell: left navigation plus the routed page outlet. */
export function App() {
  return (
    <div className="tv-app">
      <Sidebar />
      <main className="tv-main">
        <Routes>
          <Route path="/" element={<BrowsePage />} />
          <Route path="/projects/:projectId" element={<SessionListPage />} />
          <Route path="/projects/:projectId/memory" element={<ProjectMemoryPage />} />
          <Route path="/sessions/:id" element={<SessionPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/memory/:connectorId" element={<AgentMemoryPage />} />
          <Route path="/memory/:connectorId/:projectId" element={<AgentProjectMemoryPage />} />
        </Routes>
      </main>
    </div>
  );
}
