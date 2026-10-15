/**
 * Drive `document.visibilityState` from a spec.
 *
 * jsdom reports every document as permanently `visible` and never fires
 * `visibilitychange`, so code that behaves differently in a background tab can
 * only be exercised by overriding the getter and dispatching the event by hand.
 * `setPageVisibility` does both, in the order a browser does: the state changes
 * first, then listeners run.
 *
 * Call `resetPageVisibility()` in `afterEach`. The override lives on the shared
 * `document`, so a spec that leaves the page hidden would make the next spec in
 * the file run as a background tab.
 */
let currentState: DocumentVisibilityState = 'visible';
let installed = false;

function install(): void {
  if (installed) return;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => currentState,
  });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => currentState === 'hidden',
  });
  installed = true;
}

export function setPageVisibility(state: DocumentVisibilityState): void {
  install();
  currentState = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Put the page back to visible WITHOUT dispatching, so no listener runs. */
export function resetPageVisibility(): void {
  install();
  currentState = 'visible';
}
