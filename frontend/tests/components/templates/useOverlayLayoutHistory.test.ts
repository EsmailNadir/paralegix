import { act, renderHook } from '@testing-library/react';
import { useOverlayLayoutHistory, type LayoutSnapshot } from '@/components/templatesComp/useOverlayLayoutHistory';

const snapshot = (n: number): LayoutSnapshot => ({ placements: [], repeaters: [{ name: `r${n}`, rowHeightPercent: n, rowCount: 1 }] });

function setup() {
  const restore = jest.fn();
  const hook = renderHook(({ current }) => useOverlayLayoutHistory(current, restore), {
    initialProps: { current: snapshot(0) },
  });
  return { ...hook, restore };
}

describe('useOverlayLayoutHistory', () => {
  it('undoes to the layout captured at the checkpoint, and redoes forward', () => {
    const { result, rerender, restore } = setup();
    expect(result.current.canUndo).toBe(false);

    act(() => result.current.checkpoint());
    rerender({ current: snapshot(1) });
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.undo());
    expect(restore).toHaveBeenLastCalledWith(snapshot(0));
    expect(result.current.canRedo).toBe(true);

    // The caller applied the restore; the hook now holds the restored layout.
    rerender({ current: snapshot(0) });
    act(() => result.current.redo());
    expect(restore).toHaveBeenLastCalledWith(snapshot(1));
  });

  it('collapses a run of checkpoints with one key into a single undo step', () => {
    const { result, rerender, restore } = setup();

    act(() => result.current.checkpoint('nudge:p1'));
    rerender({ current: snapshot(1) });
    act(() => result.current.checkpoint('nudge:p1'));
    rerender({ current: snapshot(2) });

    act(() => result.current.undo());
    expect(restore).toHaveBeenLastCalledWith(snapshot(0));
    expect(result.current.canUndo).toBe(false);
  });

  it('keeps checkpoints with different keys as separate steps', () => {
    const { result, rerender, restore } = setup();

    act(() => result.current.checkpoint('nudge:p1'));
    rerender({ current: snapshot(1) });
    act(() => result.current.checkpoint('style:p1'));
    rerender({ current: snapshot(2) });

    act(() => result.current.undo());
    expect(restore).toHaveBeenLastCalledWith(snapshot(1));
  });

  it('drops the redo stack when a new change follows an undo', () => {
    const { result, rerender } = setup();
    act(() => result.current.checkpoint());
    rerender({ current: snapshot(1) });
    act(() => result.current.undo());
    rerender({ current: snapshot(0) });

    act(() => result.current.checkpoint());
    expect(result.current.canRedo).toBe(false);
  });

  it('forgets everything on reset', () => {
    const { result, rerender } = setup();
    act(() => result.current.checkpoint());
    rerender({ current: snapshot(1) });

    act(() => result.current.reset());
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});
