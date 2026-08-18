import { useEffect, useState } from 'react';
import { SNAP_ROTATE_DEG, SNAP_TRANSLATE_MM, useKerros } from '../core/store';
import type { DisplayMode, GizmoMode, ViewName, WorkspaceMode } from '../core/store';
import { KERROS_VERSION } from '../version';
import { ErrorBoundary } from './ErrorBoundary';
import { FeatureTree } from './FeatureTree';
import { Inspector } from './Inspector';
import { ProfilePanel } from './ProfilePanel';
import { SliceInspector } from './SliceInspector';
import { Viewport } from './Viewport';
import { useSlices } from './useSlices';

const VIEWS: { key: ViewName; label: string }[] = [
  { key: 'persp', label: 'Orbit' },
  { key: 'top', label: 'Top' },
  { key: 'front', label: 'Front' },
  { key: 'side', label: 'Side' },
];

const MODES: { key: GizmoMode; label: string; hint: string }[] = [
  { key: 'translate', label: 'Move', hint: 'Move the selected shape (M)' },
  { key: 'rotate', label: 'Rotate', hint: 'Rotate the selected shape (R)' },
];

const MODE_TABS: { key: WorkspaceMode; label: string }[] = [
  { key: 'model', label: 'Model' },
  { key: 'slice', label: 'Slice' },
  { key: 'stack', label: 'Stack' },
];

const DISPLAYS: { key: DisplayMode; label: string; hint: string }[] = [
  { key: 'solid', label: 'Solid', hint: 'Opaque surface' },
  { key: 'xray', label: 'X-ray', hint: 'See the cavity and the rods inside' },
  { key: 'wire', label: 'Wire', hint: 'Wireframe only' },
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
  const mode = useKerros((s) => s.mode);
  const setMode = useKerros((s) => s.setMode);
  const displayMode = useKerros((s) => s.displayMode);
  const setDisplayMode = useKerros((s) => s.setDisplayMode);

  const currentLayer = useKerros((s) => s.currentLayer);
  const setCurrentLayer = useKerros((s) => s.setCurrentLayer);

  const [tab, setTab] = useState<Tab>('inspector');

  // Slicing runs only while a view needs it, and once for both consumers.
  const {
    set: slices,
    reports: sliceReports,
    ms: sliceMs,
    pending: slicePending,
  } = useSlices(mode !== 'model');
  const layerCount = slices?.slices.length ?? 0;

  // Picking a feature is a request to edit it, so bring the inspector forward.
  useEffect(() => {
    if (selectedId) setTab('inspector');
  }, [selectedId]);

  // Slicing settings live in the profiles panel, so open it on the way there.
  useEffect(() => {
    if (mode !== 'model') setTab('profiles');
  }, [mode]);

  // Layer stepping belongs to the workspace, not to one panel: paging up and
  // down the stack is the same gesture whether you are looking at a single
  // layer in 2D or at the whole assembly.
  useEffect(() => {
    if (mode === 'model' || layerCount === 0) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const clamped = Math.min(Math.max(currentLayer, 1), layerCount);
      if (event.key === 'ArrowUp' || event.key === ']') {
        setCurrentLayer(Math.min(clamped + 1, layerCount));
        event.preventDefault();
      } else if (event.key === 'ArrowDown' || event.key === '[') {
        setCurrentLayer(Math.max(clamped - 1, 1));
        event.preventDefault();
      } else if (event.key === 'Home') {
        setCurrentLayer(1);
        event.preventDefault();
      } else if (event.key === 'End') {
        setCurrentLayer(layerCount);
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, layerCount, currentLayer, setCurrentLayer]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">Kerros</span>
          <span className="brand-version">v{KERROS_VERSION}</span>
        </div>

        <nav className="views" aria-label="Workspace">
          {MODE_TABS.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`view-btn${mode === m.key ? ' is-active' : ''}`}
              onClick={() => setMode(m.key)}
            >
              {m.label}
            </button>
          ))}
        </nav>

        <nav className="views toolbar" aria-label="Camera view">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              disabled={mode === 'slice'}
              className={`view-btn${view === v.key && mode !== 'slice' ? ' is-active' : ''}`}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </nav>

        <div className="toolbar" aria-label="Display">
          {DISPLAYS.map((d) => (
            <button
              key={d.key}
              type="button"
              title={d.hint}
              disabled={mode !== 'model'}
              className={`view-btn${
                displayMode === d.key && mode === 'model' ? ' is-active' : ''
              }`}
              onClick={() => setDisplayMode(d.key)}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="toolbar" aria-label="Transform tool">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              title={m.hint}
              disabled={!selectedId || mode !== 'model'}
              className={`view-btn${gizmoMode === m.key ? ' is-active' : ''}`}
              onClick={() => setGizmoMode(m.key)}
            >
              {m.label}
            </button>
          ))}
          <button
            type="button"
            title={`Snap to ${SNAP_TRANSLATE_MM} mm and ${SNAP_ROTATE_DEG}°`}
            disabled={!selectedId || mode !== 'model'}
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

        <ErrorBoundary label={mode === 'slice' ? 'Slice inspector' : 'Viewport'}>
          {mode === 'slice' ? (
            <SliceInspector
              slices={slices}
              reports={sliceReports}
              ms={sliceMs}
              pending={slicePending}
            />
          ) : (
            <Viewport slices={slices} />
          )}
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
            {tab === 'inspector' ? (
              <Inspector />
            ) : (
              <ProfilePanel slices={slices} reports={sliceReports} />
            )}
          </ErrorBoundary>
        </section>
      </main>
    </div>
  );
}
