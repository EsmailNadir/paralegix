interface PointerDragOptions {
  /** Called for each move of the pointer that started the drag. */
  onMove: (event: PointerEvent) => void;
  /**
   * Called once when the drag ends. `aborted` is true when it ended because a
   * second pointer landed or the browser cancelled the gesture - for instance
   * when it claimed a one-finger drag as a scroll - rather than because the
   * pointer was released. A drag that ends that way is not a completed action.
   */
  onEnd?: (info: { aborted: boolean }) => void;
}

/**
 * Runs a drag from a pointerdown through to its release for a mouse, a finger or
 * a pen alike. Pointer events cover all three, where the mouse events these
 * interactions were originally built on never fire for touch at all.
 *
 * A second pointer landing mid-drag ends the drag, so a two-finger zoom that
 * happens to start on a draggable element doesn't drag it at the same time.
 *
 * The element this is started from also needs `touch-none`: without it the
 * browser claims a one-finger drag as a pan and stops delivering pointer moves.
 */
export function startPointerDrag(
  event: { pointerId: number },
  { onMove, onEnd }: PointerDragOptions,
) {
  const { pointerId } = event;

  const finish = (aborted: boolean) => {
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    window.removeEventListener('pointercancel', handleCancel);
    window.removeEventListener('pointerdown', handleOtherPointer);
    onEnd?.({ aborted });
  };

  const handleMove = (e: PointerEvent) => {
    if (e.pointerId === pointerId) onMove(e);
  };

  const handleUp = (e: PointerEvent) => {
    if (e.pointerId === pointerId) finish(false);
  };

  const handleCancel = (e: PointerEvent) => {
    if (e.pointerId === pointerId) finish(true);
  };

  const handleOtherPointer = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) finish(true);
  };

  window.addEventListener('pointermove', handleMove);
  window.addEventListener('pointerup', handleUp);
  window.addEventListener('pointercancel', handleCancel);
  window.addEventListener('pointerdown', handleOtherPointer);
}

export default startPointerDrag;
