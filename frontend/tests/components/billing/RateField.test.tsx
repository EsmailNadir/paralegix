import { render, screen, fireEvent } from '@testing-library/react';
import RateField, { type RateOption } from '@/components/billingComp/RateField';

describe('RateField', () => {
  const availableRates: RateOption[] = [
    { label: 'Matter rate', rate: 350.0 },
    { label: 'Client rate', rate: 300.0 },
    { label: 'Firm default', rate: 250.0 },
  ];

  it('renders input with value and resolved placeholder', () => {
    const handleChange = jest.fn();
    const handlePick = jest.fn();

    render(
      <RateField
        value="350.00"
        onChange={handleChange}
        onPick={handlePick}
        resolvedRate={250.0}
        rateSource="matter member rate"
        hasManualRate={false}
        availableRates={availableRates}
      />,
    );

    const input = screen.getByDisplayValue('350.00');
    expect(input).toBeInTheDocument();
  });

  it('allows picking an alternate rate from the available rates dropdown', () => {
    const handleChange = jest.fn();
    const handlePick = jest.fn();

    render(
      <RateField
        value=""
        onChange={handleChange}
        onPick={handlePick}
        resolvedRate={250.0}
        rateSource="firm default rate"
        hasManualRate={false}
        availableRates={availableRates}
      />,
    );

    // Click "Change rate" button to open dropdown
    const changeRateBtn = screen.getByText('Change rate');
    fireEvent.click(changeRateBtn);

    // Dropdown options should now be visible
    expect(screen.getByText('Available rates')).toBeInTheDocument();
    const clientRateBtn = screen.getByText('Client rate');
    fireEvent.click(clientRateBtn);

    expect(handlePick).toHaveBeenCalledWith(300.0, 'Client rate');
  });

  it('shows warning style when warn prop is true', () => {
    const { container } = render(
      <RateField
        value=""
        onChange={jest.fn()}
        onPick={jest.fn()}
        resolvedRate={null}
        rateSource={null}
        hasManualRate={false}
        availableRates={[]}
        warn={true}
      />,
    );

    expect(screen.getByText('No default rate found')).toBeInTheDocument();
    expect(container.querySelector('.border-amber-300')).toBeInTheDocument();
  });
});
