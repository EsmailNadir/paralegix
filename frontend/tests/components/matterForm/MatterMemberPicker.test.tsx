import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MatterMemberPicker from '@/components/matterComp/matterForm/MatterMemberPicker';
import type { User } from '@/types';

const users = [
  { uid: 'u1', name: 'Dana Reyes', email: 'dana@firm.test' },
  { uid: 'u2', name: 'Sam Ortiz', email: 'sam@firm.test' },
] as User[];

function renderPicker(onAdd = jest.fn()) {
  const utils = render(
    <div style={{ overflow: 'hidden' }}>
      <MatterMemberPicker
        users={users}
        memberUserIds={[]}
        leadUserIds={[]}
        onAdd={onAdd}
        onRemove={jest.fn()}
        onToggleLead={jest.fn()}
        onToggleAll={jest.fn()}
        subtitle="Who works on this matter"
        emptyState={<p>No members yet</p>}
      />
    </div>,
  );
  return { ...utils, onAdd };
}

describe('MatterMemberPicker', () => {
  it('renders the member list outside the picker, so a clipping parent cannot cut it off', async () => {
    const { container } = renderPicker();

    await userEvent.click(screen.getByPlaceholderText('Search members...'));
    const option = await screen.findByRole('button', { name: /Dana Reyes/ });

    expect(container.contains(option)).toBe(false);
  });

  it('adds the member clicked in the portalled list', async () => {
    const { onAdd } = renderPicker();

    await userEvent.click(screen.getByPlaceholderText('Search members...'));
    await userEvent.click(await screen.findByRole('button', { name: /Sam Ortiz/ }));

    expect(onAdd).toHaveBeenCalledWith('u2');
  });
});
