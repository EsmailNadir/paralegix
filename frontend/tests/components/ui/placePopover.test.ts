import { placePopover } from '@/components/ui/datePickerCore';

/**
 * Where a calendar popover lands, across the viewports this app actually runs
 * on. Two bugs are the reason these exist.
 *
 * The popover used to derive its top from a height it had not measured yet,
 * which left a visible gap between it and its trigger whenever the guess ran
 * long. And it right-aligned to the trigger minus a stray 8px, so it lined up
 * with nothing.
 *
 * Every assertion here is a viewport edge or the trigger edge it must meet. A
 * pixel constant on its own would say nothing.
 */
const MARGIN = 8;
const GAP = 4;
const WIDTH = 288;

/** A trigger box, in the viewport coordinates `position: fixed` uses. */
const trigger = (over: Partial<Record<'top' | 'bottom' | 'left' | 'right', number>> = {}) => ({
  top: 300,
  bottom: 340,
  left: 100,
  right: 600,
  ...over,
});

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };

describe('placePopover', () => {
  describe('vertical placement', () => {
    it('opens below the trigger when there is room', () => {
      const style = placePopover(trigger(), WIDTH, 320, DESKTOP);

      expect(style.top).toBe(340 + GAP);
      expect(style.bottom).toBeUndefined();
    });

    /** The bug: a top derived from an unmeasured height leaves a gap. */
    it('pins the bottom edge when it opens upward, whatever the height', () => {
      const near = placePopover(trigger({ top: 700, bottom: 740 }), WIDTH, 320, DESKTOP);
      const far = placePopover(trigger({ top: 700, bottom: 740 }), WIDTH, undefined, DESKTOP);

      // Both sit the same 4px above the trigger, because the pinned edge is the
      // one next to it rather than one computed from a height.
      expect(near.bottom).toBe(DESKTOP.height - 700 + GAP);
      expect(far.bottom).toBe(near.bottom);
      expect(near.top).toBeUndefined();
    });

    it('stays below when below is tight but still the better side', () => {
      // 300px under the trigger, 200 above: neither fits a 320 popover, so the
      // roomier side wins and the popover scrolls inside itself.
      const style = placePopover(trigger({ top: 212, bottom: 588 }), WIDTH, 320, { width: 1440, height: 900 });

      expect(style.top).toBe(588 + GAP);
      expect(style.maxHeight).toBe(900 - 588 - MARGIN - GAP);
    });

    it('clamps its height to the room above, so a tall popover scrolls', () => {
      // 688px of room above, for a popover that wants 800.
      const style = placePopover(trigger({ top: 700, bottom: 740 }), WIDTH, 800, { width: 1440, height: 760 });

      expect(style.bottom).toBeDefined();
      expect(style.maxHeight).toBe(700 - MARGIN - GAP);
    });

    it('takes its own height when that is shorter than the room it has', () => {
      const style = placePopover(trigger({ top: 700, bottom: 740 }), WIDTH, 320, DESKTOP);

      expect(style.maxHeight).toBe(320);
    });

    it('keeps a minimum height on a viewport too short for either side', () => {
      const style = placePopover(trigger({ top: 160, bottom: 200 }), WIDTH, 340, { width: 1440, height: 360 });

      expect(style.maxHeight).toBeGreaterThanOrEqual(120);
    });
  });

  describe('horizontal placement', () => {
    it('lines up with the left edge of its trigger', () => {
      const style = placePopover(trigger({ left: 100 }), WIDTH, 320, DESKTOP);

      expect(style.left).toBe(100);
    });

    it('flips to the right edge when a left-aligned box would run off', () => {
      // A filter row picker at the far right: 1300 + 288 is past 1440.
      const style = placePopover(trigger({ left: 1300, right: 1420 }), WIDTH, 320, DESKTOP);

      expect(style.left).toBe(1420 - WIDTH);
      expect((style.left as number) + WIDTH).toBeLessThanOrEqual(DESKTOP.width - MARGIN);
    });

    it('never crosses the left edge, even flipping off a narrow trigger', () => {
      const style = placePopover(trigger({ left: 12, right: 60 }), WIDTH, 320, PHONE);

      expect(style.left).toBeGreaterThanOrEqual(MARGIN);
    });

    it('never crosses the right edge, wherever the trigger sits', () => {
      for (const left of [0, 40, 200, 340, 374]) {
        const style = placePopover(trigger({ left, right: left + 40 }), WIDTH, 320, PHONE);
        const right = (style.left as number) + (style.width as number);
        expect(right).toBeLessThanOrEqual(PHONE.width - MARGIN);
      }
    });
  });

  describe('narrow viewports', () => {
    it('keeps its full width on a phone, which is wide enough for it', () => {
      const style = placePopover(trigger({ left: 16, right: 359 }), WIDTH, 320, PHONE);

      expect(style.width).toBe(WIDTH);
      expect((style.left as number) + WIDTH).toBeLessThanOrEqual(PHONE.width - MARGIN);
    });

    it('shrinks below a viewport too narrow for the full calendar', () => {
      const narrow = { width: 280, height: 700 };
      const style = placePopover(trigger({ left: 0, right: 280 }), WIDTH, 320, narrow);

      expect(style.width).toBe(narrow.width - MARGIN * 2);
      expect(style.width).toBeLessThan(WIDTH);
    });

    it('keeps its full width when the viewport has room', () => {
      const style = placePopover(trigger(), WIDTH, 320, DESKTOP);

      expect(style.width).toBe(WIDTH);
    });

    it('stops shrinking at a usable width, and scrolls sideways instead', () => {
      const style = placePopover(trigger({ left: 0, right: 200 }), WIDTH, 320, { width: 200, height: 800 });

      expect(style.width).toBe(240);
      expect(style.left).toBe(MARGIN);
    });
  });
});
