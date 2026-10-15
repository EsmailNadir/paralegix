import { canPreviewCalendarConnections } from '@/components/calendarComp/calendarConnectionPreview';

describe('calendar connection preview access', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('allows local development on %s', (hostname) => {
    expect(canPreviewCalendarConnections('development', hostname)).toBe(true);
  });

  it.each([
    ['production', 'localhost'],
    ['production', 'staging.paralegix.com'],
    ['development', 'staging.paralegix.com'],
    ['development', 'paralegix.com'],
    ['test', 'localhost'],
  ])('blocks preview in %s on %s', (nodeEnv, hostname) => {
    expect(canPreviewCalendarConnections(nodeEnv, hostname)).toBe(false);
  });
});
