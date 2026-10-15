import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SkipLink from '@/components/ui/SkipLink';

it('moves keyboard focus into main content so the next Tab skips navigation', async () => {
  const user = userEvent.setup();
  render(<>
    <SkipLink />
    <nav><button>Navigation action</button></nav>
    <main id="main-content" tabIndex={-1}><button>Content action</button></main>
  </>);
  await user.tab();
  expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('main')).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Content action' })).toHaveFocus();
});
