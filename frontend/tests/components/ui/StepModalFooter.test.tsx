import { render, screen, fireEvent } from '@testing-library/react';
import StepModalFooter from '@/components/ui/StepModalFooter';

/**
 * The five wizards wrote this footer out each time. Two conditions decide what
 * it shows, and getting either backwards strands the user: step 1 offers Cancel
 * rather than Back, and only the last step offers the submit rather than
 * Continue.
 */
describe('StepModalFooter', () => {
  const setup = (props: Partial<React.ComponentProps<typeof StepModalFooter>> = {}) => {
    const handlers = {
      onCancel: jest.fn(),
      onBack: jest.fn(),
      onContinue: jest.fn(),
      submit: { onClick: jest.fn(), label: 'Create' },
    };
    render(<StepModalFooter currentStep={1} stepCount={3} {...handlers} {...props} />);
    return handlers;
  };

  it('offers Cancel on the first step, where there is nothing to go back to', () => {
    const handlers = setup({ currentStep: 1 });

    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it('offers Back from the second step on', () => {
    const handlers = setup({ currentStep: 2 });

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
  });

  it('offers Continue while steps remain', () => {
    const handlers = setup({ currentStep: 2, stepCount: 3 });

    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(handlers.onContinue).toHaveBeenCalledTimes(1);
  });

  it('offers the submit on the last step, under the wizard own label', () => {
    const onClick = jest.fn();
    setup({ currentStep: 3, stepCount: 3, submit: { onClick, label: 'Save Changes' } });

    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('holds Continue shut until the step has what it needs', () => {
    const handlers = setup({ currentStep: 1, stepCount: 3, continueDisabled: true });

    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(handlers.onContinue).not.toHaveBeenCalled();
  });

  it('holds the submit shut while it is in flight', () => {
    const onClick = jest.fn();
    setup({
      currentStep: 3,
      stepCount: 3,
      submit: { onClick, loading: true, disabled: true, label: 'Creating...' },
    });

    const button = screen.getByRole('button', { name: /Creating/ });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('holds Cancel shut while busy, so a save in flight cannot be abandoned', () => {
    const handlers = setup({ currentStep: 1, busy: true });

    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it('holds Back shut while busy, so a save in flight cannot be navigated away from', () => {
    const handlers = setup({ currentStep: 3, stepCount: 3, busy: true });

    const button = screen.getByRole('button', { name: 'Back' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(handlers.onBack).not.toHaveBeenCalled();
  });
});
