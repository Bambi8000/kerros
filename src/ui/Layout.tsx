import { useEffect, useState } from 'react';
import { useKerros } from '../core/store';
import type { ViewName } from '../core/store';
import { KERROS_VERSION } from '../version';
import { ErrorBoundary } from './ErrorBoundary';
import { FeatureTree } from './FeatureTree';
import { Inspector } from './Inspector';
import { ProfilePanel } from './ProfilePanel';
import { Viewport } from './Viewport';

const VIEWS: { key: ViewName; label: string }[] = [
  { key: 'persp', label: 'Orbit' },
  { key: 'top', label: 'Top' },
  { key: 'front', label: 'Front' },
  { key: 'side', label: 'Side' },
];

type Tab = 'inspector' | 'profiles';

export function Layout() {
  const view = useKerros((s) => s.view);
  const setView = useKerros((s) => s.setView);
  const machine = useKerros((s) => s.machine);
  const material = useKerros((s) => s.material);
  const selectedId = useKerros((s) => s.selectedId);

  const [tab, setTab] = useState<Tab>('inspector');

  // Picking a feature is a request to edit it, so bring the inspector forward.
  useEffect(() => {
    if (selectedId) setTab('inspector');
  }, [selectedId]);

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

        <section className="panel panel-right">
          <header className="panel-head panel-head-tabs">
            <button
              type="button"
              className={`tab${tab === 'inspector' ? ' is-active' : ''}`}
              onClick={() => setTab('inspector')}
            >
              Inspector
            </button>
            <button
              type="button"
              className={`tab${tab === 'profiles' ? ' is-active' : ''}`}
              onClick={() => setTab('profiles')}
            >
              Profiles
            </button>
          </header>

          <ErrorBoundary label={tab === 'inspector' ? 'Inspector' : 'Profiles'}>
            {tab === 'inspector' ? <Inspector /> : <ProfilePanel />}
          </ErrorBoundary>
        </section>
      </main>
    </div>
  );
}
