import { render, screen, fireEvent } from '@testing-library/react';
import EventAssigneePicker from '@/components/eventComp/EventAssigneePicker';
import EventLinkedFiles from '@/components/eventComp/EventLinkedFiles';

/**
 * Both events tabs carried these, along with the assignee search state, its
 * filter and its toggle, all identical.
 *
 * The ids and the names are two positional arrays rather than one list of
 * objects, because that is how the event payload carries them. Keeping them
 * lined up through a removal is the thing most likely to break, so it is what
 * these pin.
 */
const USERS = [
  { id: 'u1', name: 'Rosa Delgado', email: 'rosa@firm.test' },
  { id: 'u2', name: 'Amos Whitlock', email: 'amos@firm.test' },
  { uid: 'u3', name: 'Priya Raman' },
];

describe('EventAssigneePicker', () => {
  const setup = (props: Partial<React.ComponentProps<typeof EventAssigneePicker>> = {}) => {
    const onChange = jest.fn();
    render(
      <EventAssigneePicker
        users={USERS}
        assignedTo={[]}
        assignedToName={[]}
        onChange={onChange}
        {...props}
      />,
    );
    return onChange;
  };

  it('lists every member before a search narrows it', () => {
    setup();
    expect(screen.getByText('Rosa Delgado')).toBeInTheDocument();
    expect(screen.getByText('Amos Whitlock')).toBeInTheDocument();
    expect(screen.getByText('Priya Raman')).toBeInTheDocument();
  });

  it('searches the name and the email, ignoring case', () => {
    setup();
    const box = screen.getByPlaceholderText('Search team members...');

    fireEvent.change(box, { target: { value: 'DELGADO' } });
    expect(screen.getByText('Rosa Delgado')).toBeInTheDocument();
    expect(screen.queryByText('Amos Whitlock')).not.toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'amos@firm' } });
    expect(screen.getByText('Amos Whitlock')).toBeInTheDocument();
    expect(screen.queryByText('Rosa Delgado')).not.toBeInTheDocument();
  });

  it('says so when a search matches nobody', () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText('Search team members...'), {
      target: { value: 'nobody here' },
    });
    expect(screen.getByText('No members found')).toBeInTheDocument();
  });

  it('adds an id and its name together', () => {
    const onChange = setup();

    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(onChange).toHaveBeenCalledWith(['u1'], ['Rosa Delgado']);
  });

  it('falls back to the uid for a member without an id', () => {
    const onChange = setup();

    fireEvent.click(screen.getAllByRole('checkbox')[2]);
    expect(onChange).toHaveBeenCalledWith(['u3'], ['Priya Raman']);
  });

  /**
   * The bug this shape invites: removing by name rather than by position. Two
   * members really can share a name, and then a name-based removal drops both
   * names while dropping one id, and every chip after it shows the wrong person.
   */
  it('removes the name at the same position as the id, not every equal name', () => {
    const onChange = setup({
      users: [
        { id: 'u1', name: 'Rosa Delgado' },
        { id: 'u2', name: 'Chris Okafor' },
        { id: 'u3', name: 'Chris Okafor' },
      ],
      assignedTo: ['u1', 'u2', 'u3'],
      assignedToName: ['Rosa Delgado', 'Chris Okafor', 'Chris Okafor'],
    });

    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    expect(onChange).toHaveBeenCalledWith(['u1', 'u3'], ['Rosa Delgado', 'Chris Okafor']);
  });

  it('removes from the chip as well as from the list', () => {
    const onChange = setup({ assignedTo: ['u1'], assignedToName: ['Rosa Delgado'] });

    // The chip carries the × button; the list row carries a checkbox.
    const chipRemove = screen.getByRole('button', { name: '×' });
    fireEvent.click(chipRemove);
    expect(onChange).toHaveBeenCalledWith([], []);
  });
});

describe('EventLinkedFiles', () => {
  const FILES = [
    { fileId: 'f1', name: 'Complaint.pdf' },
    { fileId: 'f2', name: 'Exhibit A.pdf' },
  ] as React.ComponentProps<typeof EventLinkedFiles>['files'];

  it('offers the picker even with nothing linked yet', () => {
    const onBrowse = jest.fn();
    render(<EventLinkedFiles files={[]} onChange={jest.fn()} onBrowse={onBrowse} />);

    fireEvent.click(screen.getByRole('button', { name: /Browse Files/ }));
    expect(onBrowse).toHaveBeenCalledTimes(1);
  });

  it('drops only the file whose unlink was clicked', () => {
    const onChange = jest.fn();
    render(<EventLinkedFiles files={FILES} onChange={onChange} onBrowse={jest.fn()} />);

    expect(screen.getByText('Complaint.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Unlink file' })[0]);
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ fileId: 'f2' })]);
  });
});
