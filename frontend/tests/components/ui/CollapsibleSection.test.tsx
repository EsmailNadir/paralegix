import { render, screen, fireEvent } from '@testing-library/react';
import CollapsibleSection from '@/components/ui/CollapsibleSection';

describe('CollapsibleSection', () => {
  it('renders section title and summary when collapsed', () => {
    render(
      <CollapsibleSection
        title="Billing Configuration"
        summary="Hourly ($350/hr)"
        open={false}
        onToggle={jest.fn()}
      >
        <p>Billing form body</p>
      </CollapsibleSection>,
    );

    expect(screen.getByText('Billing Configuration')).toBeInTheDocument();
    expect(screen.getByText('Hourly ($350/hr)')).toBeInTheDocument();
  });

  it('toggles open state and fires onToggle callback on click', () => {
    const handleToggle = jest.fn();

    render(
      <CollapsibleSection
        title="Custom Fields"
        description="Matter-specific custom data fields"
        open={true}
        onToggle={handleToggle}
      >
        <p>Custom field inputs</p>
      </CollapsibleSection>,
    );

    expect(screen.getByText('Matter-specific custom data fields')).toBeInTheDocument();
    expect(screen.getByText('Custom field inputs')).toBeInTheDocument();

    const toggleBtn = screen.getByRole('button', { name: /custom fields/i });
    fireEvent.click(toggleBtn);

    expect(handleToggle).toHaveBeenCalled();
  });

  it('renders the description and the summary at the same type size and colour', () => {
    // Both lines take turns in one slot under the title. Different classes made
    // the header subtext resize every time the section was toggled.
    const { rerender } = render(
      <CollapsibleSection
        title="Remit To"
        description="Where clients send payment."
        summary="Paralegix Demo Firm"
        open={true}
        onToggle={jest.fn()}
      >
        <p>Remit to form body</p>
      </CollapsibleSection>,
    );

    const descriptionClasses = screen.getByText('Where clients send payment.').className.split(' ');
    expect(descriptionClasses).toContain('text-xs');
    expect(descriptionClasses).toContain('text-on-surface-muted');

    rerender(
      <CollapsibleSection
        title="Remit To"
        description="Where clients send payment."
        summary="Paralegix Demo Firm"
        open={false}
        onToggle={jest.fn()}
      >
        <p>Remit to form body</p>
      </CollapsibleSection>,
    );

    const summaryClasses = screen.getByText('Paralegix Demo Firm').className.split(' ');
    // `truncate` keeps the summary on one line; every type class must match.
    expect(summaryClasses.filter((c) => c !== 'truncate').sort()).toEqual(
      descriptionClasses.sort(),
    );
  });

  it('swaps the header subtext and padding on the same tick as the body', () => {
    // The header used to wait 300ms for the body to finish collapsing, which
    // made closing a second movement that landed after the fold.
    const { container, rerender } = render(
      <CollapsibleSection
        title="Remit To"
        description="Where clients send payment."
        summary="Paralegix Demo Firm"
        open={true}
        onToggle={jest.fn()}
      >
        <p>Remit to form body</p>
      </CollapsibleSection>,
    );

    const header = () => screen.getByRole('button', { name: /remit to/i }).parentElement!;
    expect(header().className).toContain('pb-3');

    rerender(
      <CollapsibleSection
        title="Remit To"
        description="Where clients send payment."
        summary="Paralegix Demo Firm"
        open={false}
        onToggle={jest.fn()}
      >
        <p>Remit to form body</p>
      </CollapsibleSection>,
    );

    // No timer is advanced: the closed header must be settled already.
    expect(header().className).toContain('pb-4');
    expect(screen.getByText('Paralegix Demo Firm')).toBeInTheDocument();
    expect(screen.queryByText('Where clients send payment.')).not.toBeInTheDocument();
    expect(container.querySelector('[style*="0fr"]')).toBeInTheDocument();
  });
});
