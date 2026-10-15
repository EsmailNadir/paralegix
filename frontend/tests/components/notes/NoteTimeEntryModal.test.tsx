/**
 * NotesSection renders ONE NoteTimeEntryModal and re-targets it at whichever
 * note "Add time" was clicked on, passing that note's subject and content as
 * the defaults. The form must therefore start over every time it opens.
 *
 * Red if the per-open reset is keyed on anything narrower than "the dialog just
 * opened" (it was keyed on the edited entry's id, which is null for every add,
 * so a second "Add time" kept the first note's activity, description and the
 * typed duration).
 */
import React from 'react';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import NoteTimeEntryModal from '@/components/notesComp/NoteTimeEntryModal';
import { renderWithProviders } from '../../support/renderWithProviders';

function props(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true,
    onClose: jest.fn(),
    onSubmit: jest.fn().mockResolvedValue(undefined),
    defaultDate: '2026-03-14',
    ...overrides,
  };
}

function hoursInput() {
  return screen.getAllByRole('spinbutton')[0];
}

describe('NoteTimeEntryModal reopened for another note', () => {
  it("starts from the new note's defaults, not what was typed for the previous one", () => {
    const first = props({ defaultActivityName: 'Call with opposing counsel', defaultDescription: 'Discussed dates' });
    const { rerender } = renderWithProviders(<NoteTimeEntryModal {...first} />);

    fireEvent.change(hoursInput(), { target: { value: '3' } });
    expect(screen.getByLabelText('Activity')).toHaveValue('Call with opposing counsel');

    rerender(<NoteTimeEntryModal {...first} isOpen={false} />);
    const second = props({ defaultActivityName: 'Draft settlement letter', defaultDescription: 'First draft' });
    rerender(<NoteTimeEntryModal {...second} />);

    expect(screen.getByLabelText('Activity')).toHaveValue('Draft settlement letter');
    expect(screen.getByLabelText('Description')).toHaveValue('First draft');
    expect(hoursInput()).toHaveValue(1);
  });

  it('drops an edit the user abandoned when the same entry is opened again', () => {
    const entry = {
      id: 'nte-1',
      hours: 2,
      entryDate: '2026-03-10',
      name: 'Research',
      description: 'Case law',
      billable: true,
      editable: true,
    };
    const base = props({ entry });
    const { rerender } = renderWithProviders(<NoteTimeEntryModal {...(base as any)} />);

    fireEvent.change(screen.getByLabelText('Activity'), { target: { value: 'Typed then cancelled' } });
    rerender(<NoteTimeEntryModal {...(base as any)} isOpen={false} />);
    rerender(<NoteTimeEntryModal {...(base as any)} />);

    expect(screen.getByLabelText('Activity')).toHaveValue('Research');
  });
});

describe('NoteTimeEntryModal while saving', () => {
  it('cannot be cancelled while the save is in flight', async () => {
    const onClose = jest.fn();
    renderWithProviders(<NoteTimeEntryModal {...props({ onClose, submitting: true })} />);

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Red if the shared duration core removes the note-specific day limit.
it('allows exactly one day on a note and blocks an additional minute', async () => {
  const values = props();
  renderWithProviders(<NoteTimeEntryModal {...values} />);
  fireEvent.change(hoursInput(), { target: { value: '24' } });
  await userEvent.click(screen.getByRole('button', { name: 'Add Time' }));
  expect(values.onSubmit).toHaveBeenCalledTimes(1);
  expect(values.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ timeSpent: 24, timeEntryDate: '2026-03-14' }));
  fireEvent.change(screen.getAllByRole('spinbutton')[1], { target: { value: '1' } });
  expect(screen.getAllByRole('spinbutton')[1]).toHaveValue(1);
  expect(screen.getByRole('button', { name: 'Add Time' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Add Time' }));
  expect(values.onSubmit).toHaveBeenCalledTimes(1);
});
