import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Cpu, FolderOpen, LineChart, Search, Settings, type LucideIcon } from 'lucide-react';
import { ErrorBoundary } from './components';
import { useServerStatus } from './status/StatusProvider.js';
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
import { SettingsPage } from './pages/settings/SettingsPage.js';

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

/** Left navigation sidebar. */
function Sidebar() {
  const { updateAvailable, version } = useServerStatus();

  return (
    <nav className="tv-nav">
      <NavLink to="/" className="tv-nav__brand" end>
        <img
          className="tv-nav__brand-logo"
          src="/favicon.svg"
          width={24}
          height={24}
          alt=""
          aria-hidden="true"
        />
        <span className="tv-nav__brand-text">Claudescope</span>
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
      {/* Settings anchors the bottom of the sidebar, apart from the main nav. */}
      <NavLink
        to="/settings"
        className={({ isActive }) => (isActive ? 'tv-nav__link is-active' : 'tv-nav__link')}
      >
        <Settings size={16} aria-hidden="true" />
        Settings
      </NavLink>
      {version ? <span className="tv-nav__version tv-mono">v{version}</span> : null}
      {updateAvailable ? (
        <div className="tv-nav__footer">
          <span className="tv-nav__update" title={`Update available: v${updateAvailable}`}>
            v{updateAvailable} available — <code className="tv-mono">claudescope update</code>
          </span>
        </div>
      ) : null}
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
            <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
