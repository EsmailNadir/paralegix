import { render, screen } from '@testing-library/react';
import Card, { CARD_CLS } from '@/components/ui/Card';
import Th, { thClass } from '@/components/ui/Th';
import SectionLabel, { sectionLabelClass } from '@/components/ui/SectionLabel';

/**
 * Byte-exact assertions. Each literal below was copied out of the pre-migration
 * codebase, so a failure here means a card, header cell or eyebrow changed size,
 * weight, colour or spacing somewhere. That is a visual change, not a refactor.
 */
describe('Card', () => {
  it('renders the exact class string the 28 inline sites rendered', () => {
    render(<Card data-testid="card">body</Card>);
    expect(screen.getByTestId('card').className).toBe(
      'bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden',
    );
  });

  it('keeps the arbitrary shadow value exactly, since no Tailwind step matches it', () => {
    // A `shadow-sm` substitution would be a different shadow. The whole reason to
    // extract the string was that this value cannot be eyeballed.
    expect(CARD_CLS).toContain('shadow-[0_1px_3px_rgba(0,0,0,0.04)]');
  });

  it('renders a bare div with no wrapper', () => {
    const { container } = render(<Card>body</Card>);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.tagName).toBe('DIV');
  });

  it('appends className, which the list and grid cards rely on', () => {
    render(<Card data-testid="card" className="divide-y divide-outline-subtle">body</Card>);
    expect(screen.getByTestId('card').className).toBe(`${CARD_CLS} divide-y divide-outline-subtle`);
  });
});

describe('Th', () => {
  it('renders the exact left and right spellings the 26 inline sites used', () => {
    expect(thClass('left')).toBe(
      'text-left px-5 py-3 font-medium text-on-surface-secondary text-xs uppercase tracking-wide',
    );
    expect(thClass('right')).toBe(
      'text-right px-5 py-3 font-medium text-on-surface-secondary text-xs uppercase tracking-wide',
    );
  });

  it('defaults to left, which is what a header cell without an align prop was', () => {
    expect(thClass()).toBe(thClass('left'));
  });

  it('differs between aligns ONLY in the alignment class', () => {
    // Padding, weight, size and case must match, or a numeric column sits at a
    // different height from the text column beside it.
    const left = thClass('left').split(' ').slice(1);
    const right = thClass('right').split(' ').slice(1);
    expect(left).toEqual(right);
  });

  it('renders a th element', () => {
    render(<table><thead><tr><Th>Name</Th></tr></thead></table>);
    expect(screen.getByText('Name').tagName).toBe('TH');
  });
});

describe('SectionLabel', () => {
  it('renders the exact class string each pre-migration tone used', () => {
    expect(sectionLabelClass()).toBe(
      'text-[10px] font-semibold text-on-surface-muted uppercase tracking-[0.1em]',
    );
    expect(sectionLabelClass({ tone: 'secondary' })).toBe(
      'text-[10px] font-semibold text-on-surface-secondary uppercase tracking-[0.1em]',
    );
    expect(sectionLabelClass({ tone: 'inherit' })).toBe(
      'text-[10px] font-semibold uppercase tracking-[0.1em]',
    );
  });

  it('renders every margin step that was in use, and none when gap is 0', () => {
    expect(sectionLabelClass({ gap: '0' })).not.toContain('mb-');
    expect(sectionLabelClass({ gap: '1' })).toContain(' mb-1');
    expect(sectionLabelClass({ gap: '1.5' })).toContain(' mb-1.5');
    expect(sectionLabelClass({ gap: '2' })).toContain(' mb-2');
    expect(sectionLabelClass({ gap: '3' })).toContain(' mb-3');
    expect(sectionLabelClass({ gap: '4' })).toContain(' mb-4');
  });

  it('puts the margin before any appended className, matching the original order', () => {
    expect(sectionLabelClass({ gap: '2', className: 'px-3 mt-2' })).toBe(
      'text-[10px] font-semibold text-on-surface-muted uppercase tracking-[0.1em] mb-2 px-3 mt-2',
    );
  });

  it('renders the element the call site asks for, since it changes the document outline', () => {
    const { container: p } = render(<SectionLabel>Details</SectionLabel>);
    expect(p.firstElementChild?.tagName).toBe('P');
    const { container: h } = render(<SectionLabel as="h4">Details</SectionLabel>);
    expect(h.firstElementChild?.tagName).toBe('H4');
    const { container: s } = render(<SectionLabel as="span">Details</SectionLabel>);
    expect(s.firstElementChild?.tagName).toBe('SPAN');
  });

  it('is not the same thing as FieldLabel', () => {
    // FieldLabel is text-sm, sentence case, and points at a control. This one is
    // text-[10px] and uppercase and names a region. Merging them would resize
    // every form label in the product.
    expect(sectionLabelClass()).toContain('text-[10px]');
    expect(sectionLabelClass()).toContain('uppercase');
  });
});
