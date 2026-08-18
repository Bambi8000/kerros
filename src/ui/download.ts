/**
 * Getting files out of Kerros, and one file back in.
 *
 * Every export in the program goes through this module — sheet DXFs, the build
 * manifest, the kerf test, the project file. That was a deliberate boundary from
 * M3, when there was only the browser download to hide behind it, and this is
 * where it pays: the native shell landed and this is the only module that
 * changed.
 *
 * Two branches, one API:
 *
 *   native   a real save dialog, or one folder chosen once for a whole batch,
 *            and the file written straight there
 *   browser  the download dance — Blob, anchor, Downloads folder, move by hand
 *
 * The browser branch stays because `npm run dev` in a browser is still the fast
 * way to work: no compile, instant reload. The native shell is for when files
 * have to land somewhere real.
 */

export interface SaveOutcome {
  ok: boolean;
  /** What to tell the person: a path, a count, or what went wrong. */
  message: string;
  /** True when they dismissed the dialog. Not a failure, and not worth a warning. */
  cancelled?: boolean;
}

export interface NamedFile {
  name: string;
  contents: string;
}

/**
 * Are we inside the native shell?
 *
 * Tauri 2 exposes its bridge on the window before any of our code runs, so this
 * is a plain presence check rather than a version sniff.
 */
export function isNative(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * The folder a batch export writes into, remembered for the session.
 *
 * Asked for once. Exporting eleven sheets should not mean eleven dialogs, and
 * it should not mean eleven downloads throttled 350 ms apart either.
 */
let exportFolder: string | null = null;

export function currentExportFolder(): string | null {
  return exportFolder;
}

export function forgetExportFolder(): void {
  exportFolder = null;
}

/* ------------------------------------------------------------------ *
 * Browser
 * ------------------------------------------------------------------ */

function browserDownload(file: NamedFile, mime: string): void {
  const blob = new Blob([file.contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoked on the next tick so the click has definitely been handled.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Ask the browser for a file, without keeping a hidden input around. */
function browserPick(accept: string): Promise<NamedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, contents: String(reader.result ?? '') });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });

    // A dismissed picker fires no event in most browsers, so a cancel simply
    // never resolves as a file. The input is removed on the next interaction.
    document.body.appendChild(input);
    input.click();
  });
}

/* ------------------------------------------------------------------ *
 * Native
 * ------------------------------------------------------------------ */

async function nativeWrite(file: NamedFile, directory: string | null): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('write_text_file', {
    directory,
    name: file.name,
    contents: file.contents,
  });
}

/** Extension without the dot, for the dialog's filter. */
function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at > 0 ? name.slice(at + 1) : 'txt';
}

/* ------------------------------------------------------------------ *
 * The API the rest of the program uses
 * ------------------------------------------------------------------ */

/** Save one file. Native gets a save dialog; the browser downloads it. */
export async function saveText(
  file: NamedFile,
  mime = 'application/dxf',
): Promise<SaveOutcome> {
  if (!isNative()) {
    browserDownload(file, mime);
    return { ok: true, message: `${file.name} is in your Downloads folder` };
  }

  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const extension = extensionOf(file.name);
    const chosen = await save({
      defaultPath: file.name,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });

    if (!chosen) return { ok: false, cancelled: true, message: 'Not saved' };

    const written = await nativeWrite({ name: chosen, contents: file.contents }, null);
    return { ok: true, message: `Saved to ${written}` };
  } catch (error) {
    return { ok: false, message: String(error) };
  }
}

/**
 * Save several files at once.
 *
 * Native: one folder, chosen once and remembered, everything written into it.
 * Browser: the old sequential download, spaced out because browsers throttle a
 * burst of them from a single gesture.
 */
export async function saveMany(
  files: NamedFile[],
  mime = 'application/dxf',
): Promise<SaveOutcome> {
  if (files.length === 0) return { ok: true, message: 'Nothing to save' };

  if (!isNative()) {
    files.forEach((file, i) => {
      window.setTimeout(() => browserDownload(file, mime), i * 350);
    });
    return {
      ok: true,
      message: `${files.length} files are going to your Downloads folder`,
    };
  }

  try {
    if (exportFolder === null) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const chosen = await open({ directory: true, multiple: false });
      if (typeof chosen !== 'string') {
        return { ok: false, cancelled: true, message: 'Not saved' };
      }
      exportFolder = chosen;
    }

    for (const file of files) {
      await nativeWrite(file, exportFolder);
    }

    return { ok: true, message: `${files.length} files written to ${exportFolder}` };
  } catch (error) {
    // A folder that has gone away should not be remembered.
    exportFolder = null;
    return { ok: false, message: String(error) };
  }
}

/** Ask for a file to open. Returns null when the person changed their mind. */
export async function openText(
  extensions: string[],
  accept: string,
): Promise<NamedFile | null> {
  if (!isNative()) return browserPick(accept);

  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const chosen = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Kerros', extensions }],
    });
    if (typeof chosen !== 'string') return null;

    const { invoke } = await import('@tauri-apps/api/core');
    const contents = await invoke<string>('read_text_file', { path: chosen });
    return { name: chosen, contents };
  } catch {
    return null;
  }
}
