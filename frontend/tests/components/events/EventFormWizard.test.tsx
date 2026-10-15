import React from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../support/renderWithProviders';
import EventFormWizard from '@/components/eventComp/EventFormWizard';

describe('EventFormWizard', () => {
  it('uses the settled three-step modal flow and saves only from the final step', async () => {
    const user = userEvent.setup();
    const submit = jest.fn();

    renderWithProviders(
      <EventFormWizard
        isOpen
        onClose={jest.fn()}
        title="Add Matter Event"
        canContinue
        canSubmit
        onSubmit={submit}
      >
        {(step) => <p>Step {step} content</p>}
      </EventFormWizard>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Add Matter Event' });
    expect(within(dialog).getByRole('navigation', { name: 'Form progress' })).toBeInTheDocument();
    expect(within(dialog).getByText('Step 1 content')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add Event' })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByText('Step 2 content')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Back' })).toHaveClass('min-w-[88px]');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByText('Step 3 content')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Add Event' }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('lets an existing event jump directly to any stage', async () => {
    const user = userEvent.setup();

    const { rerender } = renderWithProviders(
      <EventFormWizard
        isOpen={false}
        onClose={jest.fn()}
        title="Edit Event"
        canContinue
        canSubmit
        onSubmit={jest.fn()}
      >
        {(step) => <p>Step {step} content</p>}
      </EventFormWizard>,
    );

    rerender(
      <EventFormWizard
        isOpen
        onClose={jest.fn()}
        title="Edit Event"
        canContinue
        canSubmit
        startWithAllStepsReachable
        onSubmit={jest.fn()}
      >
        {(step) => <p>Step {step} content</p>}
      </EventFormWizard>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Edit Event' });
    await user.click(within(dialog).getByRole('button', { name: /Location & Options, step 3 of 3, completed/i }));

    expect(within(dialog).getByText('Step 3 content')).toBeInTheDocument();
  });

  it('holds Cancel and the step indicator shut while the save is in flight', () => {
    renderWithProviders(
      <EventFormWizard
        isOpen
        onClose={jest.fn()}
        title="Edit Event"
        canContinue
        canSubmit
        startWithAllStepsReachable
        submitting
        onSubmit={jest.fn()}
      >
        {(step) => <p>Step {step} content</p>}
      </EventFormWizard>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Edit Event' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /Location & Options, step 3 of 3, completed/i })).toBeDisabled();
  });

  it('cannot be dismissed while the save is in flight', () => {
    const onClose = jest.fn();
    renderWithProviders(
      <EventFormWizard isOpen onClose={onClose} title="Edit Event" canContinue canSubmit submitting onSubmit={jest.fn()}>
        {(step) => <p>Step {step} content</p>}
      </EventFormWizard>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit Event' })).toBeInTheDocument();
  });
});
