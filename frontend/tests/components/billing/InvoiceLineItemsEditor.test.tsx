/**
 * Edit mode for an invoice's line items.
 *
 * A time-entry line carries two independent strings: `name` (the bold title the
 * read view and the PDF print) and `description` (the grey line under it). Only
 * the description was ever editable, so a title typed on the time entry could
 * never be corrected from the invoice.
 *
 * Both are now edited in a dialog opened from the row, rather than as two boxes
 * inside a 190px table cell. The row keeps printing the pair as text, so the
 * edit table reads like the read view it replaces.
 */
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import InvoiceLineItemsEditor from '@/components/billingComp/InvoiceLineItemsEditor';
import type { EditableLine } from '@/hooks/billingHooks/useInvoiceLineItemEditor';

const PREVIEW = {
  subtotal: 855,
  tax: 0,
  total: 855,
  hours: 1.9,
  settled: 0,
  creditIfSaved: 0,
  delta: 0,
};

function timeLine(overrides: Partial<EditableLine> = {}): EditableLine {
  return {
    rowKey: 'time_entry-te-1-0',
    id: 'te-1',
    name: 'Pretrial conference',
    description: 'Appeared before Judge Alvarez on the contested motion',
    rate: 450,
    hours: 1.9,
    amount: 855,
    hoursInput: '1',
    minutesInput: '54',
    ...overrides,
  } as EditableLine;
}

function renderEditor(props: Partial<React.ComponentProps<typeof InvoiceLineItemsEditor>> = {}) {
  const setTimeEntries = jest.fn();
  const setFlatFees = jest.fn();
  const setExpenses = jest.fn();
  const view = render(
    <InvoiceLineItemsEditor
      timeEntries={[timeLine()]}
      setTimeEntries={setTimeEntries}
      flatFees={[]}
      setFlatFees={setFlatFees}
      expenses={[]}
      setExpenses={setExpenses}
      preview={PREVIEW}
      taxRate={0}
      submitting={false}
      error={null}
      onClearError={jest.fn()}
      onCancel={jest.fn()}
      onSave={jest.fn()}
      {...props}
    />,
  );
  return { ...view, setTimeEntries, setFlatFees, setExpenses };
}

/**
 * What the editor handed the setter, applied to the lines it was rendered with.
 *
 * Row edits are sent as updaters rather than finished arrays, so two changes in
 * one tick compose instead of overwriting each other. The resulting state is
 * what these assert either way.
 */
function applied(setter: jest.Mock, before: EditableLine[]): EditableLine[] {
  const arg = setter.mock.calls[0][0];
  return typeof arg === 'function' ? arg(before) : arg;
}

/** The row control that opens the text dialog, one per time entry line. */
function textButtons() {
  return screen.getAllByRole('button', { name: /Edit title and description/ });
}

function dialog() {
  return screen.getByRole('dialog');
}

describe('InvoiceLineItemsEditor time entry rows', () => {
  it('prints the title and description as text rather than as boxes', () => {
    renderEditor();

    const row = textButtons()[0];
    expect(within(row).getByText('Pretrial conference')).toBeInTheDocument();
    expect(
      within(row).getByText('Appeared before Judge Alvarez on the contested motion'),
    ).toBeInTheDocument();

    // The pair used to occupy two inputs in the first column. Only the numbers
    // are edited in place now.
    expect(screen.queryByDisplayValue('Pretrial conference')).not.toBeInTheDocument();
    expect(
      screen.queryByDisplayValue('Appeared before Judge Alvarez on the contested motion'),
    ).not.toBeInTheDocument();
  });

  it('shows the read view fallback where a line has no title', () => {
    renderEditor({ timeEntries: [timeLine({ name: '' })] });

    expect(within(textButtons()[0]).getByText('Service')).toBeInTheDocument();
  });

  it('keeps the rate and the hours editable in the row', () => {
    const { setTimeEntries } = renderEditor();

    fireEvent.change(screen.getByLabelText('Rate'), { target: { value: '500' } });

    expect(applied(setTimeEntries, [timeLine()])).toEqual([expect.objectContaining({ rate: 500 })]);
  });
});

describe('InvoiceLineItemsEditor text dialog', () => {
  it('opens closed, and seeds both fields from the row it was opened from', () => {
    renderEditor();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(textButtons()[0]);

    expect(within(dialog()).getByLabelText('Title')).toHaveValue('Pretrial conference');
    expect(within(dialog()).getByLabelText('Description')).toHaveValue(
      'Appeared before Judge Alvarez on the contested motion',
    );
  });

  it('writes both strings back to the line on Done', () => {
    const { setTimeEntries } = renderEditor();

    fireEvent.click(textButtons()[0]);
    fireEvent.change(within(dialog()).getByLabelText('Title'), {
      target: { value: 'Pretrial conference appearance' },
    });
    fireEvent.change(within(dialog()).getByLabelText('Description'), {
      target: { value: 'Argued the contested parenting-time motion' },
    });

    expect(setTimeEntries).not.toHaveBeenCalled();

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));

    expect(setTimeEntries).toHaveBeenCalledTimes(1);
    expect(applied(setTimeEntries, [timeLine()])).toEqual([
      expect.objectContaining({
        name: 'Pretrial conference appearance',
        description: 'Argued the contested parenting-time motion',
        rate: 450,
        amount: 855,
      }),
    ]);
  });

  it('leaves the line alone on Cancel', () => {
    const { setTimeEntries } = renderEditor();

    fireEvent.click(textButtons()[0]);
    fireEvent.change(within(dialog()).getByLabelText('Title'), { target: { value: 'Discarded' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    expect(setTimeEntries).not.toHaveBeenCalled();
  });

  it('writes to the row it was opened from, not the first one', () => {
    const { setTimeEntries } = renderEditor({
      timeEntries: [
        timeLine(),
        timeLine({
          rowKey: 'time_entry-te-2-1',
          id: 'te-2',
          name: 'File-stamp the decree',
          description: 'Calendared the deadlines',
        }),
      ],
    });

    fireEvent.click(textButtons()[1]);
    fireEvent.change(within(dialog()).getByLabelText('Title'), {
      target: { value: 'File-stamp and calendar the decree' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));

    const next = applied(setTimeEntries, [
      timeLine(),
      timeLine({
        rowKey: 'time_entry-te-2-1',
        id: 'te-2',
        name: 'File-stamp the decree',
        description: 'Calendared the deadlines',
      }),
    ]);
    expect(next[0]).toEqual(expect.objectContaining({ name: 'Pretrial conference' }));
    expect(next[1]).toEqual(
      expect.objectContaining({
        name: 'File-stamp and calendar the decree',
        description: 'Calendared the deadlines',
      }),
    );
  });

  it('reseeds the fields when a second row is opened after the first', () => {
    renderEditor({
      timeEntries: [
        timeLine(),
        timeLine({
          rowKey: 'time_entry-te-2-1',
          id: 'te-2',
          name: 'File-stamp the decree',
          description: 'Calendared the deadlines',
        }),
      ],
    });

    fireEvent.click(textButtons()[0]);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(textButtons()[1]);

    expect(within(dialog()).getByLabelText('Title')).toHaveValue('File-stamp the decree');
  });

  it('leaves the title field empty rather than seeding the read view fallback', () => {
    // The row prints "Service" where a line has no title. Seeding that word into
    // the field would save it as if the user had typed it.
    renderEditor({ timeEntries: [timeLine({ name: '' })] });

    fireEvent.click(textButtons()[0]);

    expect(within(dialog()).getByLabelText('Title')).toHaveValue('');
  });
});

describe('InvoiceLineItemsEditor amount rows', () => {
  // Flat fees and expenses print their description as the title everywhere: the
  // read view, the PDF and the LEDES export. They carry one string and one
  // number, so the row has the room to edit both in place.
  it('keeps a flat fee editable in the row, with no text dialog', () => {
    const fee = {
      rowKey: 'flat_fee-ff-1-0',
      id: 'ff-1',
      description: 'Filing fee',
      amount: 300,
    } as EditableLine;
    const { setFlatFees } = renderEditor({ timeEntries: [], flatFees: [fee] });

    expect(screen.queryByRole('button', { name: /Edit title and description/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('Filing fee'), { target: { value: 'Court filing fee' } });

    expect(applied(setFlatFees, [fee])).toEqual([
      expect.objectContaining({ description: 'Court filing fee' }),
    ]);
  });
});

describe('InvoiceLineItemsEditor column widths', () => {
  /**
   * jsdom lays out no tables, so these pin the MECHANISM rather than the pixels.
   * Content-driven column sizing is what let an amount that gained a digit take
   * width from the description beside it and rewrap the row; `table-fixed` plus
   * a declared width per column is what stops it. Remove either and the bug is
   * back, which is what these go red on.
   */
  const fee = {
    rowKey: 'flat_fee-ff-1-0',
    id: 'ff-1',
    description: 'Filing fee',
    amount: 300,
  } as EditableLine;

  function tables(container: HTMLElement) {
    return Array.from(container.querySelectorAll('table'));
  }

  it('lays out every line table with fixed columns', () => {
    const { container } = renderEditor({ flatFees: [fee] });

    const found = tables(container);
    expect(found).toHaveLength(2);
    found.forEach((table) => expect(table).toHaveClass('table-fixed'));
  });

  it('declares a width for every column but the description', () => {
    const { container } = renderEditor({ flatFees: [fee] });

    tables(container).forEach((table) => {
      const cols = Array.from(table.querySelectorAll('col'));
      expect(cols.length).toBeGreaterThan(1);
      // The first column is the prose one: it takes what the others leave.
      expect(cols[0].getAttribute('class')).toBeNull();
      cols.slice(1).forEach((col) => expect(col.getAttribute('class')).toMatch(/^w-/));
    });
  });

  it('sizes a column once, on the col, not again on the cells', () => {
    // Two spellings of one width is how the read view and the editor drifted
    // apart the first time.
    const { container } = renderEditor({ flatFees: [fee] });

    tables(container)
      .flatMap((table) => Array.from(table.querySelectorAll('td, th')))
      .forEach((cell) => expect(cell.getAttribute('class') || '').not.toMatch(/(^|\s)w-\d/));
  });
});

describe('InvoiceLineItemsEditor edit mode banner', () => {
  /**
   * Edit mode swaps the read tables for the same tables with inputs, which on a
   * quick look is no change at all. The banner says what mode the panel is in,
   * and carries the actions so they are not below a full invoice's worth of
   * lines. The card around the editor is `overflow-hidden`, so a sticky bar
   * would stick to nothing.
   */
  it('says the panel is being edited', () => {
    renderEditor();

    expect(screen.getByRole('heading', { name: 'Editing line items' })).toBeInTheDocument();
  });

  it('puts the actions above the tables, not after them', () => {
    const { container } = renderEditor();

    const save = screen.getByRole('button', { name: 'Save changes' });
    const firstTable = container.querySelector('table') as HTMLElement;

    // DOCUMENT_POSITION_FOLLOWING: the table comes after the button.
    expect(save.compareDocumentPosition(firstTable) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers one Cancel and one Save, not a pair at each end', () => {
    renderEditor();

    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Save changes' })).toHaveLength(1);
  });

  it('still runs the editor its own save and cancel handlers', () => {
    const onSave = jest.fn();
    const onCancel = jest.fn();
    renderEditor({ onSave, onCancel });

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('InvoiceLineItemsEditor hours and minutes', () => {
  /**
   * HoursMinutesInput reports a carry as two calls, one per field. The other two
   * call sites hold the pair in two `useState` atoms, so two calls are fine
   * there. This one holds every line in a single array, so both calls patched
   * the same array and the second silently threw the first away.
   *
   * These need real state, not a jest.fn(): the defect is what survives when two
   * updates land in one tick.
   */
  function StatefulEditor({ initial }: { initial: EditableLine[] }) {
    const [timeEntries, setTimeEntries] = React.useState(initial);
    return (
      <InvoiceLineItemsEditor
        timeEntries={timeEntries}
        setTimeEntries={setTimeEntries}
        flatFees={[]}
        setFlatFees={jest.fn()}
        expenses={[]}
        setExpenses={jest.fn()}
        preview={PREVIEW}
        taxRate={0}
        submitting={false}
        error={null}
        onClearError={jest.fn()}
        onCancel={jest.fn()}
        onSave={jest.fn()}
      />
    );
  }

  /** The hours and minutes boxes of one row, in that order. */
  function fields(rowIndex = 0) {
    const row = document.querySelectorAll('tbody tr')[rowIndex] as HTMLElement;
    const [hours, minutes] = within(row).getAllByPlaceholderText('0');
    return { hours, minutes };
  }

  it('folds a typed minutes value over 59 into the hours beside it', () => {
    render(<StatefulEditor initial={[timeLine({ hoursInput: '', minutesInput: '' })]} />);

    const { minutes } = fields();
    fireEvent.change(minutes, { target: { value: '199' } });
    fireEvent.keyDown(minutes, { key: 'Enter' });

    // 199 minutes is 3h 19m. The hours half used to be discarded, leaving 19m:
    // three hours of billable work gone from the invoice on one keystroke.
    expect(fields().hours).toHaveValue(3);
    expect(fields().minutes).toHaveValue(19);
  });

  it('folds the same value in on blur', () => {
    render(<StatefulEditor initial={[timeLine({ hoursInput: '2', minutesInput: '' })]} />);

    const { minutes } = fields();
    fireEvent.change(minutes, { target: { value: '90' } });
    fireEvent.blur(minutes);

    // 2h plus 90m is 3h 30m.
    expect(fields().hours).toHaveValue(3);
    expect(fields().minutes).toHaveValue(30);
  });

  it('borrows an hour when the minutes stepper goes below zero', () => {
    render(<StatefulEditor initial={[timeLine({ hoursInput: '1', minutesInput: '' })]} />);

    fireEvent.click(within(document.querySelectorAll('tbody tr')[0] as HTMLElement)
      .getByRole('button', { name: 'Decrease minutes' }));

    // 1h 0m less 5m is 0h 55m. Dropping the hours half left 1h 55m, which is an
    // hour MORE than before the click.
    expect(fields().hours).toHaveValue(null);
    expect(fields().minutes).toHaveValue(55);
  });

  it('leaves a minutes value under 60 alone', () => {
    render(<StatefulEditor initial={[timeLine({ hoursInput: '2', minutesInput: '' })]} />);

    const { minutes } = fields();
    fireEvent.change(minutes, { target: { value: '42' } });
    fireEvent.blur(minutes);

    expect(fields().hours).toHaveValue(2);
    expect(fields().minutes).toHaveValue(42);
  });

  it('folds the carry into the row it was typed in', () => {
    render(
      <StatefulEditor
        initial={[
          timeLine({ hoursInput: '1', minutesInput: '30' }),
          timeLine({ rowKey: 'time_entry-te-2-1', id: 'te-2', hoursInput: '4', minutesInput: '15' }),
        ]}
      />,
    );

    const second = fields(1);
    fireEvent.change(second.minutes, { target: { value: '75' } });
    fireEvent.blur(second.minutes);

    expect(fields(0).hours).toHaveValue(1);
    expect(fields(0).minutes).toHaveValue(30);
    expect(fields(1).hours).toHaveValue(5);
    expect(fields(1).minutes).toHaveValue(15);
  });
});
