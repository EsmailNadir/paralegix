import { fireEvent, render, screen } from '@testing-library/react';
import Modal from '@/components/ui/Modal';

/**
 * Sizing is the component's job, not the call site's.
 *
 * Width comes from `size` and height from `height`. A caller that puts a
 * `max-w-*`, `max-h-*` or `h-*` utility in `className` used to win or lose by
 * Tailwind's emission order, which is why the app accumulated fourteen
 * different height treatments. The panel now drops those utilities and always
 * renders its own, so the outcome is the same wherever the call site sits.
 */

function panel(): HTMLElement {
  return screen.getByRole('dialog');
}

/**
 * Height classes that apply on a desktop screen. The `max-sm:` bottom-sheet cap
 * is deliberately excluded: a fixed-height panel still gets capped on a phone.
 */
function unprefixedHeightClasses(): string[] {
  return panel().className.split(' ').filter((cls) => /^(max-)?h-/.test(cls));
}

describe('Modal width', () => {
  it('defaults to the md panel', () => {
    render(<Modal isOpen onClose={() => {}} title="t">body</Modal>);
    expect(panel()).toHaveClass('max-w-md');
  });

  it.each([
    ['sm', 'max-w-sm'],
    ['lg', 'max-w-lg'],
    ['2xl', 'max-w-2xl'],
    ['5xl', 'max-w-5xl'],
    ['screen', 'max-w-[80vw]'],
  ] as const)('maps size %s to %s', (size, expected) => {
    render(<Modal isOpen onClose={() => {}} title="t" size={size}>body</Modal>);
    expect(panel()).toHaveClass(expected);
  });

  it('ignores a width utility passed through className', () => {
    render(
      <Modal isOpen onClose={() => {}} title="t" size="lg" className="max-w-5xl w-[900px]">
        body
      </Modal>,
    );
    expect(panel()).toHaveClass('max-w-lg');
    expect(panel().className).not.toContain('max-w-5xl');
    expect(panel().className).not.toContain('w-[900px]');
  });
});

describe('Modal height', () => {
  it('caps a content-sized panel at 90vh by default', () => {
    render(<Modal isOpen onClose={() => {}} title="t">body</Modal>);
    expect(unprefixedHeightClasses()).toEqual(['max-h-[90vh]']);
  });

  it('gives a fill panel a fixed height and no cap', () => {
    render(<Modal isOpen onClose={() => {}} title="t" height="fill">body</Modal>);
    expect(unprefixedHeightClasses()).toEqual(['h-[90vh]']);
  });

  it('gives a stepped panel one fixed height, so a wizard cannot resize between steps', () => {
    render(<Modal isOpen onClose={() => {}} title="t" height="steps">body</Modal>);
    expect(unprefixedHeightClasses()).toEqual(['h-[min(720px,90vh)]']);
  });

  it('leaves an uncapped panel with no desktop height class at all', () => {
    render(<Modal isOpen onClose={() => {}} title="t" height="none">body</Modal>);
    expect(unprefixedHeightClasses()).toEqual([]);
  });

  it('ignores a height utility passed through className', () => {
    render(
      <Modal isOpen onClose={() => {}} title="t" className="max-h-[50vh] h-[600px] h-full">
        body
      </Modal>,
    );
    expect(unprefixedHeightClasses()).toEqual(['max-h-[90vh]']);
  });

  it('drops a responsive width or height variant too', () => {
    render(
      <Modal isOpen onClose={() => {}} title="t" className="sm:max-w-xl md:h-[80vh] rounded-2xl">
        body
      </Modal>,
    );
    expect(panel().className).not.toContain('sm:max-w-xl');
    expect(panel().className).not.toContain('md:h-[80vh]');
    expect(panel()).toHaveClass('rounded-2xl');
  });
});

describe('Modal on a narrow screen', () => {
  /**
   * jsdom does not evaluate media queries, so these assert the classes are on
   * the element. That is the thing that regresses: a dialog rebuilt without the
   * `max-sm:` treatment is a 448px panel floating in the middle of a 375px
   * screen, which is what every dialog did before.
   */
  it('makes the panel a full-width bottom sheet below the sm breakpoint', () => {
    render(<Modal isOpen onClose={() => {}} title="t">body</Modal>);
    expect(panel()).toHaveClass('max-sm:max-w-none');
    expect(panel()).toHaveClass('max-sm:rounded-b-none');
    expect(panel()).toHaveClass('max-sm:max-h-[85svh]');
  });

  it('keeps the sheet full width whatever the size prop asks for', () => {
    render(<Modal isOpen onClose={() => {}} title="t" size="screen">body</Modal>);
    expect(panel()).toHaveClass('max-w-[80vw]');
    expect(panel()).toHaveClass('max-sm:max-w-none');
  });

  it('caps a fixed-height panel to the small viewport as well', () => {
    render(<Modal isOpen onClose={() => {}} title="t" height="steps">body</Modal>);
    expect(panel()).toHaveClass('h-[min(720px,90vh)]');
    expect(panel()).toHaveClass('max-sm:max-h-[85svh]');
  });

  it('drops the panel to the bottom edge, then centres it from sm up', () => {
    render(<Modal isOpen onClose={() => {}} title="t">body</Modal>);
    const positioner = panel().parentElement;
    expect(positioner).toHaveClass('items-end');
    expect(positioner).toHaveClass('sm:items-center');
    expect(positioner).toHaveClass('p-0');
    expect(positioner).toHaveClass('sm:p-4');
  });

  it('squares off the footer bar with the sheet', () => {
    render(
      <Modal isOpen onClose={() => {}} title="t" footer={<button type="button">Save</button>}>
        body
      </Modal>,
    );
    const bar = screen.getByText('Save').parentElement?.parentElement;
    expect(bar).toHaveClass('rounded-b-lg');
    expect(bar).toHaveClass('max-sm:rounded-b-none');
  });
});

describe('Modal footer', () => {
  function footerRow(): HTMLElement {
    const row = screen.getByText('Save').parentElement;
    if (!row) throw new Error('no footer row');
    return row;
  }

  it('end-aligns the actions by default', () => {
    render(
      <Modal isOpen onClose={() => {}} title="t" footer={<button type="button">Save</button>}>
        body
      </Modal>,
    );
    expect(footerRow()).toHaveClass('justify-end');
  });

  it('pushes the actions to both edges for a Back and Continue pair', () => {
    render(
      <Modal isOpen onClose={() => {}} title="t" footerAlign="between" footer={<button type="button">Save</button>}>
        body
      </Modal>,
    );
    expect(footerRow()).toHaveClass('justify-between');
    expect(footerRow().className).not.toContain('justify-end');
  });
});

describe('Modal className passthrough', () => {
  it('still lets a caller replace the radius and shadow', () => {
    render(
      <Modal isOpen onClose={() => {}} title="t" className="rounded-2xl shadow-2xl">
        body
      </Modal>,
    );
    expect(panel()).toHaveClass('rounded-2xl');
    expect(panel()).toHaveClass('shadow-2xl');
    expect(panel().className).not.toContain('rounded-lg');
    expect(panel().className).not.toContain('shadow-xl');
  });

  it('keeps unrelated classes', () => {
    render(
      <Modal isOpen onClose={() => {}} title="t" className="overflow-hidden border border-outline">
        body
      </Modal>,
    );
    expect(panel()).toHaveClass('overflow-hidden');
    expect(panel()).toHaveClass('border-outline');
  });
});

/**
 * The panel stays mounted for its exit animation, and the update that closes it
 * usually also changes what it would render: a form resets, a busy label reverts,
 * a result screen replaces the form. It must fade out showing what the user saw.
 */
describe('Modal while closing', () => {
  function renderStage(open: boolean, stage: string) {
    return (
      <Modal
        isOpen={open}
        onClose={() => {}}
        title={`Title ${stage}`}
        subtitle={`Subtitle ${stage}`}
        footer={<button type="button">Save {stage}</button>}
      >
        <input aria-label="Name" value={`Name ${stage}`} readOnly />
      </Modal>
    );
  }

  it('keeps the title, subtitle, body and footer it had when it closed', () => {
    const { rerender } = render(renderStage(true, 'open'));
    rerender(renderStage(false, 'reset'));

    expect(panel()).toHaveClass('overlay-card-exit');
    expect(screen.getByRole('dialog', { name: 'Title open' })).toBeInTheDocument();
    expect(screen.getByText('Subtitle open')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Name open');
    expect(screen.getByRole('button', { name: 'Save open' })).toBeInTheDocument();
    expect(screen.queryByText(/reset/)).not.toBeInTheDocument();
  });

  it('shows the new content when it reopens', () => {
    const { rerender } = render(renderStage(true, 'first'));
    rerender(renderStage(false, 'closed'));
    rerender(renderStage(true, 'second'));

    expect(screen.getByRole('dialog', { name: 'Title second' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Name second');
  });
});

describe('Modal stacked over another dialog', () => {
  /**
   * A dialog opened from inside another one (a payment over an invoice, a
   * quick-create inside a form) has to sit above it. The shell was fixed at
   * z-50, so every nested dialog hand-rolled its own z-[60] overlay instead.
   * It must also leave the parent panel's DOM: the panel animates with a
   * transform, and a transformed ancestor traps both `fixed` positioning and
   * z-index, so a nested overlay rendered in place sits inside the parent card.
   */
  function overlayOf(dialog: HTMLElement): HTMLElement {
    return dialog.closest('.fixed') as HTMLElement;
  }

  it('renders a top-level dialog at z-50', () => {
    render(<Modal isOpen onClose={() => {}} title="t">body</Modal>);
    expect(overlayOf(panel())).toHaveClass('z-50');
  });

  it('raises a stacked dialog above z-50 and portals it out of its parent', () => {
    render(
      <div data-testid="parent-panel">
        <Modal isOpen onClose={() => {}} title="nested" stacked>body</Modal>
      </div>,
    );
    const overlay = overlayOf(panel());
    expect(overlay).toHaveClass('z-[60]');
    expect(overlay).not.toHaveClass('z-50');
    expect(screen.getByTestId('parent-panel')).not.toContainElement(overlay);
    expect(overlay.parentElement).toBe(document.body);
  });
});

describe('Modal while it cannot be dismissed', () => {
  /**
   * Every caller turns dismissal off for the length of a save. Blocking only
   * the backdrop left Escape and the close button able to close a dialog
   * mid-save, so a late failure landed in a dialog that was already gone.
   */
  it('ignores the backdrop, Escape and the close button', () => {
    const onClose = jest.fn();
    render(<Modal isOpen onClose={onClose} title="t" dismissible={false}>body</Modal>);

    fireEvent.click(panel().closest('.fixed')!.firstElementChild as HTMLElement);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  });

  it('closes on each of them once dismissal is back on', () => {
    const onClose = jest.fn();
    render(<Modal isOpen onClose={onClose} title="t">body</Modal>);

    fireEvent.click(panel().closest('.fixed')!.firstElementChild as HTMLElement);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
