import { render, screen } from '@testing-library/react';
import FieldLabel, { fieldLabelClass } from '@/components/ui/FieldLabel';
import { FIELD_LABEL_BLOCK_CLS } from '@/components/ui/inputClasses';

/**
 * These are byte-exact assertions on purpose.
 *
 * `FieldLabel` replaced 313 hand-written `<label className="...">` sites, and the
 * whole point of that migration was that nothing on screen moved. The four
 * strings below are the four spellings copied verbatim out of the pre-migration
 * codebase. A `toContain` assertion would pass while a class was silently added
 * or dropped, so every case compares the complete class attribute.
 *
 * If a case here needs editing, a label somewhere changed size, colour or spacing.
 * That is a visual change, not a refactor.
 */
describe('FieldLabel', () => {
  describe('renders the exact class string each pre-migration variant used', () => {
    it('sm / default / gap-1', () => {
      expect(fieldLabelClass()).toBe('mb-1 block text-sm font-medium text-on-surface');
    });

    it('sm / secondary / gap-1', () => {
      expect(fieldLabelClass({ tone: 'secondary' })).toBe(
        'mb-1 block text-sm font-medium text-on-surface-secondary',
      );
    });

    it('xs / secondary / gap-1', () => {
      expect(fieldLabelClass({ size: 'xs', tone: 'secondary' })).toBe(
        'mb-1 block text-xs font-medium text-on-surface-secondary',
      );
    });

    it('xs / secondary / gap-1.5', () => {
      expect(fieldLabelClass({ size: 'xs', tone: 'secondary', gap: '1.5' })).toBe(
        'mb-1.5 block text-xs font-medium text-on-surface-secondary',
      );
    });

    it('xs / default / gap-1', () => {
      expect(fieldLabelClass({ size: 'xs' })).toBe(
        'mb-1 block text-xs font-medium text-on-surface',
      );
    });
  });

  it('stays identical to the FIELD_LABEL_BLOCK_CLS constant that predates it', () => {
    // Call sites that build their own label markup still import the constant. The
    // two must not drift apart, or the component and the constant render
    // different labels in the same form.
    expect(fieldLabelClass()).toBe(FIELD_LABEL_BLOCK_CLS);
  });

  it('renders a label element, not a wrapper', () => {
    // The migration replaced `<label>` tags one for one. An added wrapper element
    // would change layout everywhere at once.
    const { container } = render(<FieldLabel htmlFor="amount">Amount</FieldLabel>);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.tagName).toBe('LABEL');
  });

  it('forwards htmlFor so clicking the label focuses its control', () => {
    render(
      <>
        <FieldLabel htmlFor="matter-name">Matter name</FieldLabel>
        <input id="matter-name" />
      </>,
    );
    expect(screen.getByLabelText('Matter name')).toBeInTheDocument();
  });

  it('appends className after the base classes rather than replacing them', () => {
    render(<FieldLabel className="sr-only">Hidden</FieldLabel>);
    expect(screen.getByText('Hidden').className).toBe(
      'mb-1 block text-sm font-medium text-on-surface sr-only',
    );
  });

  it('omits htmlFor when no control id is given', () => {
    render(<FieldLabel>Standalone</FieldLabel>);
    expect(screen.getByText('Standalone')).not.toHaveAttribute('for');
  });
});
