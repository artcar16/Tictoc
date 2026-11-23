// Android back button / back gesture for overlays (dialogs, sheets, card editor, cropper, recorder).
// Where the browser supports CloseWatcher (Chrome, Edge, Samsung Internet on Android), the back
// press is delivered to the top-most open overlay as a "close request" and consumed there: it does
// not go back in the history, so the screen under the overlay stays as it is. Elsewhere (iOS has
// no back button) this is a no-op. Escape is unaffected: the overlays' keydown handlers cancel the
// event, and a cancelled Escape keydown produces no close request.
// No UI dependencies: used by media.js as well as by the UI modules.

/**
 * Call `onClose` when the user asks to close the top-most overlay (Android back).
 * The watcher fires at most once. → `unwatch()`: stop watching (call it when the overlay closes
 * by any other way; harmless after it fired).
 */
export function watchClose(onClose) {
  if (typeof CloseWatcher !== 'function') return () => {};
  let watcher;
  try {
    watcher = new CloseWatcher();
  } catch {
    return () => {};
  }
  watcher.onclose = () => {
    watcher = null;
    onClose();
  };
  return () => {
    if (!watcher) return;
    const w = watcher;
    watcher = null;
    try {
      w.destroy();
    } catch {
      /* already gone */
    }
  };
}
