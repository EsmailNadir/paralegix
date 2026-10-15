/**
 * The two task dialogs on a note's action menu: "Create task" (`NoteTaskModal`)
 * and "Link existing task" (`NoteLinkTaskModal`).
 *
 *   A REFUSED SAVE IS ANNOUNCED. The reason is shown with the shared error
 *   banner, which carries `role="alert"`, so a screen reader reads it out; a
 *   bare red line is silent.
 *
 *   THE ACTIONS SIT IN THE DIALOG'S FOOTER BAR, as in every other form dialog.
 *
 *   A CANCELLED PICK IS NOT CARRIED INTO THE NEXT OPEN. The link dialog is
 *   shared by every note in the list, so a task picked and then abandoned on
 *   one note must not come back preselected on the next.
 */
jest.mock('@/hooks/useEntityLookup', () => ({
  useDuplicateNameCheck: () => ({ duplicate: null }),
}));
jest.mock('@/components/ui/EntityPicker', () => ({
  __esModule: true,
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <button type="button" onClick={() => onChange('task-1')}>
      {value ? `Picked ${value}` : 'Pick a task'}
    </button>
  ),
}));

import React from 'react';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../support/renderWithProviders';
import NoteTaskModal from '@/components/notesComp/NoteTaskModal';
import NoteLinkTaskModal from '@/components/notesComp/NoteLinkTaskModal';

describe('NoteTaskModal', () => {
  // Red if: the refusal is a plain paragraph with no alert role.
  it('announces a refused create with the shared error banner', async () => {
    const onSubmit = jest.fn().mockRejectedValue(new Error('You cannot create tasks on this matter'));
    renderWithProviders(
      <NoteTaskModal isOpen onClose={jest.fn()} onSubmit={onSubmit} lawFirmId="firm-1" defaultTitle="Call the court" />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Create Task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot create tasks on this matter');
  });

  // Red if: the buttons are laid out inside the scrolling body.
  it('puts Cancel and Create Task in the footer bar', () => {
    renderWithProviders(
      <NoteTaskModal isOpen onClose={jest.fn()} onSubmit={jest.fn()} lawFirmId="firm-1" defaultTitle="Call the court" />,
    );

    const footer = screen.getByRole('button', { name: 'Create Task' }).closest('.border-t');
    expect(footer).not.toBeNull();
    expect(footer).toContainElement(screen.getByRole('button', { name: 'Cancel' }));
  });
});

describe('NoteLinkTaskModal', () => {
  // Red if: the refusal is a plain paragraph with no alert role.
  it('announces a refused link with the shared error banner', async () => {
    const onSubmit = jest.fn().mockRejectedValue(new Error('That task belongs to another matter'));
    renderWithProviders(<NoteLinkTaskModal isOpen onClose={jest.fn()} onSubmit={onSubmit} lawFirmId="firm-1" />);

    await userEvent.click(screen.getByRole('button', { name: 'Pick a task' }));
    await userEvent.click(screen.getByRole('button', { name: 'Link Task' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That task belongs to another matter');
    expect(screen.getByRole('button', { name: 'Link Task' }).closest('.border-t')).not.toBeNull();
  });

  // Red if: the picked task survives a cancel and is preselected next time.
  it('opens with no task picked after a cancelled pick', async () => {
    const props = { onClose: jest.fn(), onSubmit: jest.fn(), lawFirmId: 'firm-1' };
    const { rerender } = renderWithProviders(<NoteLinkTaskModal isOpen {...props} />);

    await userEvent.click(screen.getByRole('button', { name: 'Pick a task' }));
    expect(screen.getByRole('button', { name: 'Link Task' })).toBeEnabled();

    rerender(<NoteLinkTaskModal isOpen={false} {...props} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    rerender(<NoteLinkTaskModal isOpen {...props} />);

    expect(screen.getByRole('button', { name: 'Pick a task' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link Task' })).toBeDisabled();
  });
});
