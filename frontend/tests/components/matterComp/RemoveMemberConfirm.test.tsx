/**
 * The confirm shown before a member leaves a matter. It is driven by the
 * server's preview of what the removal leaves behind (open tasks, upcoming
 * events, reminder slots), and hands the caller the member who should inherit
 * the assignments, or null to leave them unassigned.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import RemoveMemberConfirm from '@/components/matterComp/RemoveMemberConfirm';

const PAT = { userId: 'u-pat', name: 'Pat Attorney' };
const SAM = { userId: 'u-sam', name: 'Sam Paralegal' };
const LEE = { userId: 'u-lee', name: 'Lee Associate' };

function renderConfirm(props: Partial<React.ComponentProps<typeof RemoveMemberConfirm>> = {}) {
  const onConfirm = jest.fn();
  const onClose = jest.fn();
  render(
    <RemoveMemberConfirm
      isOpen
      onClose={onClose}
      onConfirm={onConfirm}
      members={[PAT]}
      remainingMembers={[SAM, LEE]}
      preview={{ users: [{ userId: 'u-pat', openTasks: 0, upcomingEvents: 0, reminderSlots: 0 }] }}
      {...props}
    />,
  );
  return { onConfirm, onClose };
}

describe('a member with nothing assigned on the matter', () => {
  it('confirms as a plain removal, with no picker, and reassigns to nobody', async () => {
    const { onConfirm } = renderConfirm();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/remove .*Pat Attorney.* from this matter/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Reassign to/ })).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(onConfirm).toHaveBeenCalledWith(null);
  });
});

describe('a member with open work on the matter', () => {
  const busy = { users: [{ userId: 'u-pat', openTasks: 3, upcomingEvents: 1, reminderSlots: 0 }] };

  it('names how many tasks and events are assigned to them', async () => {
    renderConfirm({ preview: busy });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/3 open tasks and 1 upcoming event on this matter are assigned to Pat Attorney/)).toBeInTheDocument();
  });

  it('defaults to leaving the work unassigned', async () => {
    const { onConfirm } = renderConfirm({ preview: busy });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /^Reassign to/ })).toHaveTextContent('Leave unassigned');

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it('offers only the members who stay, and sends the chosen one', async () => {
    const { onConfirm } = renderConfirm({ preview: busy, remainingMembers: [PAT, SAM, LEE] });

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Reassign to/ }));
    const listbox = await screen.findByRole('listbox');
    // The member being removed cannot inherit their own work.
    expect(within(listbox).queryByRole('option', { name: 'Pat Attorney' })).not.toBeInTheDocument();
    await userEvent.click(within(listbox).getByRole('option', { name: 'Sam Paralegal' }));

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(onConfirm).toHaveBeenCalledWith('u-sam');
  });

  it('offers no picker when nobody stays to take the work over', async () => {
    renderConfirm({ preview: busy, remainingMembers: [] });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/3 open tasks/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Reassign to/ })).not.toBeInTheDocument();
  });
});

describe('a member who is only a reminder recipient', () => {
  it('says the reminders stop and offers no reassignment, since reminders are never moved', async () => {
    renderConfirm({ preview: { users: [{ userId: 'u-pat', openTasks: 0, upcomingEvents: 0, reminderSlots: 2 }] } });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/2 task reminders/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Reassign to/ })).not.toBeInTheDocument();
  });
});

describe('a preview that also covers someone who is staying', () => {
  it('counts only the member being removed', async () => {
    renderConfirm({
      preview: {
        users: [
          { userId: 'u-pat', openTasks: 0, upcomingEvents: 0, reminderSlots: 0 },
          { userId: 'u-sam', openTasks: 9, upcomingEvents: 9, reminderSlots: 9 },
        ],
      },
    });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/remove .*Pat Attorney.* from this matter/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/open tasks/)).not.toBeInTheDocument();
  });
});

describe('several members removed at once', () => {
  it('adds the counts together and never offers a removed member as the target', async () => {
    renderConfirm({
      members: [PAT, SAM],
      remainingMembers: [LEE],
      preview: {
        users: [
          { userId: 'u-pat', openTasks: 2, upcomingEvents: 0, reminderSlots: 0 },
          { userId: 'u-sam', openTasks: 1, upcomingEvents: 4, reminderSlots: 0 },
        ],
      },
    });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/3 open tasks and 4 upcoming events on this matter are assigned to the members being removed/)).toBeInTheDocument();
  });
});

describe('cancelling', () => {
  it('closes without confirming', async () => {
    const { onConfirm, onClose } = renderConfirm();

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
