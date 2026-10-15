import { render } from '@testing-library/react';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The shared `next/navigation` mock in tests/setup.ts. Next's `useRouter` reads
 * one object from context, so a component's effects that list `router` as a
 * dependency run once. A mock that built a new router per call re-ran them on
 * every render: an admin page re-checked access each time and kept dropping
 * back to its spinner.
 */
describe('the shared next/navigation mock', () => {
  it('returns the same router on every call', () => {
    expect(useRouter()).toBe(useRouter());
  });

  it('does not re-run an effect that depends on the router when a component re-renders', () => {
    const runs = jest.fn();
    function Probe({ tick }: { tick: number }) {
      const router = useRouter();
      useEffect(() => { runs(); }, [router]);
      return <span>{tick}</span>;
    }

    const { rerender } = render(<Probe tick={1} />);
    rerender(<Probe tick={2} />);
    rerender(<Probe tick={3} />);

    expect(runs).toHaveBeenCalledTimes(1);
  });
});
