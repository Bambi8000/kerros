import { useEffect } from 'react';
import { SNAP_ROTATE_DEG, SNAP_TRANSLATE_MM, hasTransform, useKerros } from '../core/store';
import type { DisplayMode, GizmoMode, ViewName, WorkspaceMode } from '../core/store';
import { KERROS_VERSION } from '../version';
import { ErrorBoundary } from './ErrorBoundary';
import { FeatureTree } from './FeatureTree';
import { Inspector } from './Inspector';
import { PartInspector } from './PartInspector';
import { ProfilePanel } from './ProfilePanel';
import { SheetView } from './SheetView';
import { SliceInspector } from './SliceInspector';
import { useSheets } from './useSheets';
import { Viewport } from './Viewport';
import { useSlices } from './useSlices';
import { SliceStatus } from './SliceStatus';
import { activeAssembly } from '../core/assembly';
import { AssemblyViewport } from './AssemblyViewport';
import { AssemblyPartView } from './AssemblyPartView';
import { AssemblyInspector } from './AssemblyInspector';
import { CurveEditor } from './CurveEditor';

const VIEWS: { key: ViewName; label: string }[] = [
  { key: 'persp', label: 'Orbit' },
  { key: 'top', label: 'Top' },
  { key: 'front', label: 'Front' },
  { key: 'side', label: 'Side' },
];

const MODES: { key: GizmoMode; label: string; hint: string }[] = [
  { key: 'translate', label: 'Move', hint: 'Move the selection (M)' },
  { key: 'rotate', label: 'Rotate', hint: 'Rotate the selection (R)' },
];

const MODE_TABS: { key: WorkspaceMode; label: string }[] = [
  { key: 'model', label: 'Model' },
  { key: 'slice', label: 'Slice' },
  { key: 'stack', label: 'Assembly' },
  { key: 'sheet', label: 'Sheet' },
];

const DISPLAYS: { key: DisplayMode; label: string; hint: string }[] = [
  { key: 'solid', label: 'Solid', hint: 'Opaque surface' },
  { key: 'xray', label: 'X-ray', hint: 'See the cavity and the rods inside' },
  { key: 'wire', label: 'Wire', hint: 'Wireframe only' },
];

// The panel choice lives in the store: selecting something is a request to
// inspect it, so the selection and the panel change happen in one place rather
// than racing in two effects.

export function Layout() {
  const view = useKerros((s) => s.view);
  const setView = useKerros((s) => s.setView);
  const machine = useKerros((s) => s.machine);
  const material = useKerros((s) => s.material);
  const movable = useKerros((s) => {
    const feature = s.features.find((f) => f.id === s.selectedId);
    if (!feature) return false;
    return s.mode === 'stack' && activeAssembly(s.features)
      ? ['assembly:rib', 'assembly:support', 'assembly:backplate', 'assembly:plate', 'assembly:channel', 'rod'].includes(feature.kind)
      : hasTransform(feature);
  });
  const sculptMode = useKerros((s) => s.sculptMode);
  const setSculptMode = useKerros((s) => s.setSculptMode);
  const ensureSculpt = useKerros((s) => s.ensureSculpt);
  const measureMode = useKerros((s) => s.measureMode);
  const setMeasureMode = useKerros((s) => s.setMeasureMode);
  const gizmoMode = useKerros((s) => s.gizmoMode);
  const setGizmoMode = useKerros((s) => s.setGizmoMode);
  const snapEnabled = useKerros((s) => s.snapEnabled);
  const setSnapEnabled = useKerros((s) => s.setSnapEnabled);
  const mode = useKerros((s) => s.mode);
  const assembly = useKerros((s) => activeAssembly(s.features));
  const selectedFeature = useKerros((s) => s.features.find((f) => f.id === s.selectedId));
  const setMode = useKerros((s) => s.setMode);
  const displayMode = useKerros((s) => s.displayMode);
  const setDisplayMode = useKerros((s) => s.setDisplayMode);

  const currentLayer = useKerros((s) => s.currentLayer);
  const setCurrentLayer = useKerros((s) => s.setCurrentLayer);
  const panel = useKerros((s) => s.panel);
  const setPanel = useKerros((s) => s.setPanel);
  const curveEditorId = useKerros(s => s.curveEditorId);
  const curveKeyId = useKerros(s => s.curveKeyId);
  const curveEditing = mode === 'slice' && selectedFeature?.id === curveEditorId && !!selectedFeature?.sketch;

  // Slicing runs only while a view needs it, and once for both consumers.
  const {
    set: slices,
    reports: sliceReports,
    windows: sliceWindows,
    patternCounts,
    holeMisses,
    punchResults,
    legGaps,
    pinLoose,
    ms: sliceMs,
    pending: slicePending,
    fresh: sliceFresh,
    error: sliceError,
    completedAt: sliceCompletedAt,
    recalculate,
    sourceFeatures: sliceSourceFeatures,
  } = useSlices(mode !== 'model');
  const sheets = useSheets(sliceFresh ? slices : null, sliceWindows);
  const layerCount = slices?.slices.length ?? 0;

  // Layer stepping belongs to the workspace, not to one panel: paging up and
  // down the stack is the same gesture whether you are looking at a single
  // layer in 2D or at the whole assembly.
  useEffect(() => {
    if (mode === 'model' || mode === 'sheet' || layerCount === 0) return;

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
      const stepTo = (index: number) => {
        setCurrentLayer(index);
        if (assembly) useKerros.getState().selectFeature(slices?.slices[index - 1]?.part?.id ?? null);
      };
      if (event.key === 'ArrowUp' || event.key === ']') {
        stepTo(Math.min(clamped + 1, layerCount));
        event.preventDefault();
      } else if (event.key === 'ArrowDown' || event.key === '[') {
        stepTo(Math.max(clamped - 1, 1));
        event.preventDefault();
      } else if (event.key === 'Home') {
        stepTo(1);
        event.preventDefault();
      } else if (event.key === 'End') {
        stepTo(layerCount);
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, layerCount, currentLayer, setCurrentLayer, assembly, slices]);

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
              {m.key === 'slice' && assembly && !curveEditing ? 'Part' : m.label}
            </button>
          ))}
        </nav>

        <nav className="views toolbar" aria-label="Camera view">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              disabled={mode === 'slice' || mode === 'sheet'}
              className={`view-btn${
                view === v.key && mode !== 'slice' && mode !== 'sheet' ? ' is-active' : ''
              }`}
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

        <div className="toolbar" aria-label="Sculpt">
          <button
            type="button"
            title="Paint on the surface: left drag paints, right drag orbits"
            disabled={mode !== 'model'}
            className={`view-btn${sculptMode && mode === 'model' ? ' is-active' : ''}`}
            onClick={() => {
              if (!sculptMode) ensureSculpt();
              setSculptMode(!sculptMode);
            }}
          >
            Sculpt
          </button>
          <button
            type="button"
            title="Measure between two points on the surface. Esc clears."
            disabled={mode !== 'model'}
            className={`view-btn${measureMode && mode === 'model' ? ' is-active' : ''}`}
            onClick={() => setMeasureMode(!measureMode)}
          >
            Measure
          </button>
        </div>

        <div className="toolbar" aria-label="Transform tool">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              title={m.hint}
              disabled={!movable || (mode !== 'model' && !(mode === 'stack' && assembly)) || Boolean(assembly && mode === 'stack' && m.key === 'rotate' && selectedFeature?.params.freePlacement !== true && !['assembly:rib', 'assembly:plate', 'assembly:channel', 'rod'].includes(selectedFeature?.kind ?? ''))}
              className={`view-btn${gizmoMode === m.key ? ' is-active' : ''}`}
              onClick={() => setGizmoMode(m.key)}
            >
              {m.label}
            </button>
          ))}
          <button
            type="button"
            title={`Snap to ${SNAP_TRANSLATE_MM} mm and ${SNAP_ROTATE_DEG}°`}
            disabled={!movable || (mode !== 'model' && !(mode === 'stack' && assembly))}
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

        <ErrorBoundary
          label={
            mode === 'slice'
              ? 'Slice inspector'
              : mode === 'sheet'
                ? 'Sheet view'
                : 'Viewport'
          }
        >
          {curveEditing ? (
            <CurveEditor key={`${curveEditorId}:${curveKeyId ?? 'base'}`} feature={selectedFeature!} slices={sliceFresh ? slices : null} />
          ) : assembly && mode === 'stack' ? (
            <AssemblyViewport set={slices} pending={slicePending} sourceFeatures={sliceSourceFeatures} />
          ) : assembly && mode === 'slice' ? (
            <AssemblyPartView set={slices} pending={slicePending} />
          ) : mode === 'slice' ? (
            <SliceInspector
              slices={slices}
              reports={sliceReports}
              ms={sliceMs}
              pending={slicePending}
            />
          ) : mode === 'sheet' ? (
            <SheetView sheets={sheets} pending={slicePending} />
          ) : (
            <Viewport slices={slices} />
          )}
        </ErrorBoundary>

        <section className="panel panel-right">
          <header className="panel-head panel-head-tabs">
            <button
              type="button"
              className={`tab${panel === 'inspector' ? ' is-active' : ''}`}
              onClick={() => setPanel('inspector')}
            >
              Inspector
            </button>
            <button
              type="button"
              className={`tab${panel === 'profiles' ? ' is-active' : ''}`}
              onClick={() => setPanel('profiles')}
            >
              Profiles
            </button>
          </header>

          {mode !== 'model' && <SliceStatus pending={slicePending} error={sliceError} completedAt={sliceCompletedAt}
            ms={sliceMs} hasResult={slices !== null} onRecalculate={recalculate} />}

          <ErrorBoundary label={panel === 'inspector' ? 'Inspector' : 'Profiles'}>
            {panel === 'inspector' ? (
              mode === 'sheet' ? (
                <PartInspector sheets={sheets} />
              ) : selectedFeature?.kind.startsWith('assembly:') ? (
                <AssemblyInspector feature={selectedFeature} set={slices} pending={slicePending || !sliceFresh} sourceFeatures={sliceSourceFeatures} />
              ) : (
                <Inspector
                  slices={slices}
                  patternCounts={patternCounts}
                  holeMisses={holeMisses}
                  punchResults={punchResults}
                  sliceFresh={sliceFresh}
                  sliceError={sliceError}
                  legGaps={legGaps}
                  pinLoose={pinLoose}
                  sliced={sliceFresh && slices !== null}
                />
              )
            ) : (
              <ProfilePanel
                slices={slices}
                reports={sliceReports}
                sheets={sheets}
                pinLoose={pinLoose}
                sliceFresh={sliceFresh}
              />
            )}
          </ErrorBoundary>
        </section>
      </main>
    </div>
  );
}
