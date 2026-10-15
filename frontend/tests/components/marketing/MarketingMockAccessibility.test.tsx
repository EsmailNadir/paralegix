import React from 'react';
import { render, screen } from '@testing-library/react';
import { CalendarMock, DashboardMock } from '@/components/marketingComp/Mockups';

it('describes product illustrations without exposing their imitation headings and sidebar as page structure', () => {
  render(<><DashboardMock /><CalendarMock events={[{ tick: 'red', title: 'Estate plan review', sub: 'Consultation', time: 'Jun 12' }]} /></>);
  expect(screen.getByRole('img', { name: /Product preview.*matter.*deadline.*billing/i })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: /Calendar preview.*Estate plan review.*Consultation.*Jun 12/i })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'June 2026' })).not.toBeInTheDocument();
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
