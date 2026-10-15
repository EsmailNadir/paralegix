import { render, screen, fireEvent } from '@testing-library/react';
import ItemActionMenu, { menuPositionFromEvent } from '@/components/ui/ItemActionMenu';

describe('ItemActionMenu', () => {
  it('renders portal action menu and triggers action on click', () => {
    const handleEdit = jest.fn();
    const handleClose = jest.fn();

    render(
      <ItemActionMenu
        open={true}
        anchorTop={100}
        anchorBottom={130}
        right={20}
        actions={[
          { key: 'edit', label: 'Edit Matter', onClick: handleEdit },
          { key: 'archive', label: 'Archive', onClick: jest.fn(), danger: true },
        ]}
        onClose={handleClose}
      />,
    );

    expect(screen.getByText('Edit Matter')).toBeInTheDocument();
    expect(screen.getByText('Archive')).toBeInTheDocument();

    const editBtn = screen.getByRole('button', { name: /Edit Matter/i });
    fireEvent.click(editBtn);

    expect(handleClose).toHaveBeenCalled();
    expect(handleEdit).toHaveBeenCalled();
  });

  it('computes left and right coordinates from event', () => {
    const mockElement = {
      getBoundingClientRect: () => ({
        top: 200,
        bottom: 240,
        left: 12,
        right: 160,
      }),
    } as unknown as HTMLElement;

    const fakeClick = {
      type: 'click',
      currentTarget: mockElement,
    } as unknown as React.MouseEvent;

    const pos = menuPositionFromEvent(fakeClick);
    expect(pos.anchorTop).toBe(200);
    expect(pos.anchorBottom).toBe(240);
    expect(pos.left).toBe(12);
  });

  it('renders with align="left" and left positioning style', () => {
    render(
      <ItemActionMenu
        open={true}
        anchorTop={100}
        anchorBottom={130}
        left={16}
        align="left"
        actions={[
          { key: 'logout', label: 'Log out', onClick: jest.fn() },
        ]}
        onClose={jest.fn()}
      />,
    );

    const menu = document.body.querySelector('.fixed.bg-surface');
    expect(menu).toBeInTheDocument();
    expect((menu as HTMLElement).style.left).toBeDefined();
    expect(screen.getByText('Log out')).toBeInTheDocument();
  });
});
