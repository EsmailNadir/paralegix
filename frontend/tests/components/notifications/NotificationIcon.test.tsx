import React from 'react';
import { render } from '@testing-library/react';
import NotificationIcon from '@/components/notificationComp/NotificationIcon';

const iconClass = (type: string) => {
  const { container } = render(<NotificationIcon notification={{ type, entityType: null } as never} />);
  return container.querySelector('svg')?.getAttribute('class') ?? '';
};

describe('NotificationIcon', () => {
  it('shows the trust icon for a failed trust deposit, like every other trust alert', () => {
    expect(iconClass('trust_deposit_failed')).toContain('lucide-landmark');
    expect(iconClass('trust_reversal_failed')).toContain('lucide-landmark');
  });

  it('falls back to the bell for a type it does not know', () => {
    expect(iconClass('something_new')).toContain('lucide-bell');
  });
});
