import { useKerros } from '../core/store';
import type { ViewName } from '../core/store';
import { KERROS_VERSION } from '../version';
import { ErrorBoundary } from './ErrorBoundary';
import { FeatureTree } from './FeatureTree';
import { ProfilePanel } from './ProfilePanel';
import { Viewport } from './Viewport';

const VIEWS: { key: ViewName; label: string }[] = [
  { key: 'persp', label: 'Orbit' },
  { key: 'top', label: 'Top' },
  { key: 'front', label: 'Front' },
  { key: 'side', label: 'Side' },
];

export function Layout() {
  const view = useKerros((s) => s.view);
  const setView = useKerros((s) => s.setView);
  const machine = useKerros((s) => s.machine);
  const material = useKerros((s) => s.material);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Kerros</span>
          <span className="brand-version">v{KERROS_VERSION}</span>
        </div>

        <nav className="views" aria-label="Camera view">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              className={`view-btn${view === v.key ? ' is-active' : ''}`}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </nav>

        <div className="topbar-status">
          <span>{machine.name}</span>
          <span className="sep">/</span>
          <span>{material.name}</span>
        </div>
      </header>

      <main className="workspace">
        <ErrorBoundary label="Feature tree">
          <FeatureTree />
        </ErrorBoundary>

        <ErrorBoundary label="Viewport">
          <Viewport />
        </ErrorBoundary>

        <ErrorBoundary label="Profiles">
          <ProfilePanel />
        </ErrorBoundary>
      </main>
    </div>
  );
}
