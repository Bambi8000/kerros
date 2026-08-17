import { useEffect, useState } from 'react';
import { SNAP_ROTATE_DEG, SNAP_TRANSLATE_MM, useKerros } from '../core/store';
import type { GizmoMode, ViewName } from '../core/store';
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

const MODES: { key: GizmoMode; label: string; hint: string }[] = [
  { key: 'translate', label: 'Move', hint: 'Move the selected shape (G)' },
  { key: 'rotate', label: 'Rotate', hint: 'Rotate the selected shape (R)' },
];

type Tab = 'inspector' | 'profiles';

export function Layout() {
  const view = useKerros((s) => s.view);
  const setView = useKerros((s) => s.setView);
  const machine = useKerros((s) => s.machine);
  const material = useKerros((s) => s.material);
  const selectedId = useKerros((s) => s.selectedId);
  const gizmoMode = useKerros((s) => s.gizmoMode);
  const setGizmoMode = useKerros((s) => s.setGizmoMode);
  const snapEnabled = useKerros((s) => s.snapEnabled);
  const setSnapEnabled = useKerros((s) => s.setSnapEnabled);

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

        <div className="toolbar" aria-label="Transform tool">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              title={m.hint}
              disabled={!selectedId}
              className={`view-btn${gizmoMode === m.key ? ' is-active' : ''}`}
              onClick={() => setGizmoMode(m.key)}
            >
              {m.label}
            </button>
          ))}
          <button
            type="button"
            title={`Snap to ${SNAP_TRANSLATE_MM} mm and ${SNAP_ROTATE_DEG}°`}
            disabled={!selectedId}
            className={`view-btn${snapEnabled ? ' is-active' : ''}`}
            onClick={() => setSnapEnabled(!snapEnabled)}
          >
            Snap
          </button>
        </div>

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
