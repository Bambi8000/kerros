/**
 * Browser download.
 *
 * This is the download dance the handoff wants gone: the file lands in
 * Downloads and has to be moved by hand. Tauri replaces it with a real save
 * dialog in M10, at which point this module is the only thing that changes.
 */
export function downloadText(filename: string, contents: string, mime = 'application/dxf') {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoked on the next tick so the click has definitely been handled.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Read a file the person picked, as text. */
export function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}
