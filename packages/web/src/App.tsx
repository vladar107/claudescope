import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Cpu, FolderOpen, LineChart, Monitor, Moon, Search, Sun, type LucideIcon } from 'lucide-react';
import type { SourceInfo } from '@claudescope/shared';
import { ErrorBoundary } from './components';
import { api } from './api/client.js';
import { useTheme, type ThemeChoice } from './theme/ThemeProvider.js';
import { BrowsePage } from './pages/browse/BrowsePage.js';
import { ProjectLayout } from './pages/browse/ProjectLayout.js';
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
  icon: LucideIcon;
  /** `end` for routes that should only match exactly (the index route). */
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Browse', icon: FolderOpen, end: true },
  { to: '/memory', label: 'Memory', icon: Cpu },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/analytics', label: 'Analytics', icon: LineChart },
];

const THEME_OPTIONS: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: 'System', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

/** Segmented System / Light / Dark theme control. */
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
          </button>
        );
      })}
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
      {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => (isActive ? 'tv-nav__link is-active' : 'tv-nav__link')}
        >
          <Icon size={16} aria-hidden="true" />
          {label}
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
  // A render throw on a page degrades to an in-place error (sidebar stays usable);
  // pathname in resetKeys clears the boundary when the user navigates elsewhere.
  const { pathname } = useLocation();
  return (
    <div className="tv-app">
      <Sidebar />
      <main className="tv-main">
        <div className="tv-main__inner">
          <ErrorBoundary resetKeys={[pathname]} title="This page failed to render">
            <Routes>
            <Route path="/" element={<BrowsePage />} />
            <Route path="/projects/:projectId" element={<ProjectLayout />}>
              <Route index element={<SessionListPage />} />
              <Route path="memory" element={<ProjectMemoryPage />} />
            </Route>
            <Route path="/sessions/:id" element={<SessionPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/memory" element={<MemoryPage />} />
            <Route path="/memory/:connectorId" element={<AgentMemoryPage />} />
            <Route path="/memory/:connectorId/:projectId" element={<AgentProjectMemoryPage />} />
            </Routes>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
