import { render } from '@testing-library/react';
import { scanAccessibility } from './accessibility';

it('reports an unlabeled input and clears the violation when its label is associated', async () => {
  const { container, rerender } = render(<input id="email" type="email" />);
  const broken = await scanAccessibility(container);
  expect(broken.violations.map((violation) => violation.id)).toContain('label');
  expect(broken.violations.find((violation) => violation.id === 'label')!.nodes[0].target)
    .toContain('#email');

  rerender(<><label htmlFor="email">Email</label><input id="email" type="email" /></>);
  const fixed = await scanAccessibility(container);
  expect(fixed.violations).toEqual([]);
});
