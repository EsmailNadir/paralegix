/**
 * Enter in `NameInputModal`'s name field does what clicking the primary button
 * does, and no more: nothing while the button is disabled or already saving.
 *
 * What has to break for these to go red: the Enter handler calling `onSubmit`
 * without checking `submitting` or `submitDisabled`, or not calling it at all.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import NameInputModal from '@/components/ui/NameInputModal';

function renderModal(props: { submitting?: boolean; submitDisabled?: boolean } = {}) {
  const onSubmit = jest.fn();
  render(
    <NameInputModal
      open
      onClose={jest.fn()}
      title="Create New Folder"
      nameField={{ label: 'Folder name *', value: 'Pleadings', onChange: jest.fn() }}
      error={null}
      onDismissError={jest.fn()}
      submitting={props.submitting ?? false}
      submitDisabled={props.submitDisabled}
      submitLabel="Create"
      onSubmit={onSubmit}
    />
  );
  return onSubmit;
}

it('submits on Enter when the form can be submitted', () => {
  const onSubmit = renderModal();

  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it('ignores Enter while a submit is already in flight', () => {
  const onSubmit = renderModal({ submitting: true });

  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

  expect(onSubmit).not.toHaveBeenCalled();
});

it('ignores Enter while the submit button is disabled', () => {
  const onSubmit = renderModal({ submitDisabled: true });

  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

  expect(onSubmit).not.toHaveBeenCalled();
});
