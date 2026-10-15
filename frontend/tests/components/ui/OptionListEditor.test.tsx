import React, { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OptionListEditor from '@/components/ui/OptionListEditor';

const latest: { options: string[] } = { options: [] };

function Harness({ initial }: { initial: string[] }) {
  const [options, setOptions] = useState(initial);
  latest.options = options;
  return <OptionListEditor options={options} onChange={setOptions} />;
}

describe('OptionListEditor', () => {
  it('renders one blank row for an empty list, and it cannot be removed', () => {
    render(<Harness initial={[]} />);

    expect(screen.getByLabelText('Option 1')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Remove option 1' })).toBeDisabled();
  });

  it('edits a row in place', async () => {
    render(<Harness initial={['Family', 'Estate']} />);

    await userEvent.type(screen.getByLabelText('Option 2'), ' Planning');

    expect(latest.options).toEqual(['Family', 'Estate Planning']);
  });

  it('inserts a blank row below on Enter and focuses it', async () => {
    render(<Harness initial={['Family', 'Estate']} />);

    await userEvent.type(screen.getByLabelText('Option 1'), '{Enter}');

    expect(latest.options).toEqual(['Family', '', 'Estate']);
    expect(screen.getByLabelText('Option 2')).toHaveFocus();
    await userEvent.keyboard('Probate');
    expect(latest.options).toEqual(['Family', 'Probate', 'Estate']);
  });

  it('removes an empty row on Backspace and focuses the row above', async () => {
    render(<Harness initial={['Family', '']} />);

    await userEvent.type(screen.getByLabelText('Option 2'), '{Backspace}');

    expect(latest.options).toEqual(['Family']);
    expect(screen.getByLabelText('Option 1')).toHaveFocus();
  });

  it('keeps a row with text on Backspace, deleting a character instead', async () => {
    render(<Harness initial={['Family', 'Tax']} />);

    await userEvent.type(screen.getByLabelText('Option 2'), '{Backspace}');

    expect(latest.options).toEqual(['Family', 'Ta']);
  });

  it('adds a row at the end and removes a chosen row', async () => {
    render(<Harness initial={['Family', 'Estate']} />);

    await userEvent.click(screen.getByRole('button', { name: /Add option/ }));
    expect(latest.options).toEqual(['Family', 'Estate', '']);
    expect(screen.getByLabelText('Option 3')).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Remove option 1' }));
    expect(latest.options).toEqual(['Estate', '']);
  });
});
