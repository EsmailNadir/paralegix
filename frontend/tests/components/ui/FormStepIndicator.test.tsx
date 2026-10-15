import { render, screen, fireEvent } from '@testing-library/react';
import FormStepIndicator from '@/components/ui/FormStepIndicator';

describe('FormStepIndicator', () => {
  const steps = [
    { label: 'Basic Info' },
    { label: 'Billing Setup' },
    { label: 'Review & Submit' },
  ];

  it('renders step labels and marks current step active', () => {
    render(<FormStepIndicator steps={steps} currentStep={2} />);

    expect(screen.getByText('Basic Info')).toBeInTheDocument();
    expect(screen.getByText('Billing Setup')).toBeInTheDocument();
    expect(screen.getByText('Review & Submit')).toBeInTheDocument();

    const currentEl = screen.getByLabelText(/Billing Setup, step 2 of 3, current/i);
    expect(currentEl).toBeInTheDocument();
  });

  it('allows clicking previously completed steps when onStepClick is provided', () => {
    const handleStepClick = jest.fn();

    render(
      <FormStepIndicator
        steps={steps}
        currentStep={2}
        maxStepReached={2}
        onStepClick={handleStepClick}
      />,
    );

    const step1Btn = screen.getByRole('button', { name: /Basic Info, step 1 of 3, completed/i });
    expect(step1Btn).toBeInTheDocument();

    fireEvent.click(step1Btn);
    expect(handleStepClick).toHaveBeenCalledWith(1);
  });

  it('holds completed steps shut while disabled, so a save in flight cannot be navigated away from', () => {
    const handleStepClick = jest.fn();

    render(
      <FormStepIndicator
        steps={steps}
        currentStep={3}
        maxStepReached={3}
        onStepClick={handleStepClick}
        disabled
      />,
    );

    const step1Btn = screen.getByRole('button', { name: /Basic Info, step 1 of 3, completed/i });
    expect(step1Btn).toBeDisabled();
    fireEvent.click(step1Btn);
    expect(handleStepClick).not.toHaveBeenCalled();
  });
});
