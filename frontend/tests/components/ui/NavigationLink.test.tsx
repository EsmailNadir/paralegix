const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({ useNavigation: () => ({ navigate: mockNavigate }) }));
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NavigationLink from '@/components/ui/NavigationLink';

beforeEach(() => mockNavigate.mockReset());
it('exposes a real destination and routes keyboard activation through the app shell', async () => {
  render(<NavigationLink href="/client/messages">Messages</NavigationLink>);
  const link = screen.getByRole('link', { name: 'Messages' });
  expect(link).toHaveAttribute('href', '/client/messages');
  await userEvent.tab();
  expect(link).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  expect(mockNavigate).toHaveBeenCalledWith('/client/messages');
});
it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])('preserves browser handling for a modified click %j', modifiers => {
  render(<NavigationLink href="/client/messages">Messages</NavigationLink>);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers });
  fireEvent(screen.getByRole('link'), click);
  expect(click.defaultPrevented).toBe(false);
  expect(mockNavigate).not.toHaveBeenCalled();
});
it('honors a caller that cancels navigation', async () => {
  render(<NavigationLink href="/client/messages" onClick={event => event.preventDefault()}>Messages</NavigationLink>);
  await userEvent.click(screen.getByRole('link'));
  expect(mockNavigate).not.toHaveBeenCalled();
});


it.each([{ target: '_blank' }, { download: 'messages.txt' }])('preserves explicit browser destinations %j', props => {
  render(<NavigationLink href="/client/messages" {...props}>Messages</NavigationLink>);
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  fireEvent(screen.getByRole('link'), click);
  expect(click.defaultPrevented).toBe(false);
  expect(mockNavigate).not.toHaveBeenCalled();
});


it('uses shell navigation when download is explicitly false', async () => {
  render(<NavigationLink href="/client/messages" download={false}>Messages</NavigationLink>);
  await userEvent.click(screen.getByRole('link'));
  expect(mockNavigate).toHaveBeenCalledWith('/client/messages');
});
