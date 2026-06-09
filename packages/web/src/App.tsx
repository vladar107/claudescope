import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import type { SourceInfo } from '@claudescope/shared';
import { api } from './api/client.js';
import { BrowsePage } from './pages/browse/BrowsePage.js';
import { SessionPage } from './pages/session/SessionPage.js';
import { SearchPage } from './pages/search/SearchPage.js';
import { AnalyticsPage } from './pages/analytics/AnalyticsPage.js';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** `end` for routes that should only match exactly (the index route). */
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Browse', icon: '📁', end: true },
  { to: '/search', label: 'Search', icon: '🔍' },
  { to: '/analytics', label: 'Analytics', icon: '📊' },
];

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

  const paths = sources.map((s) => s.path).join(' · ');
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
      <div className="tv-nav__footer" title={paths}>
        Read-only{paths ? ` · ${paths}` : ''}
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
          <Route path="/sessions/:id" element={<SessionPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
        </Routes>
      </main>
    </div>
  );
}
