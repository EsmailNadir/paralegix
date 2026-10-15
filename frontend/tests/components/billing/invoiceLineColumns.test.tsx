/**
 * Column widths for the invoice line item tables.
 *
 * jsdom does not lay a table out, so nothing here can assert a rendered pixel.
 * What it CAN pin is the mechanism that produces the pixels, and the mechanism
 * is the whole fix: `table-fixed` plus a declared width per column is what stops
 * an amount that gained a digit from resizing the description beside it. Drop
 * either half and the browser goes back to sizing every column by its content,
 * which is the bug.
 *
 * So these read as "the contract is still wired up", not "the layout is
 * correct". The second claim needs a browser.
 */
import { render } from '@testing-library/react';
import {
  AmountCols,
  DESCRIPTION_FLOOR,
  lineTableCls,
  sizedWidth,
  TimeEntryCols,
  type LineTableColumns,
  type LineTableMode,
} from '@/components/billingComp/invoiceLineColumns';

/** The width class on each column, in order. Null where a column has none. */
function widths(container: HTMLElement): (string | null)[] {
  return Array.from(container.querySelectorAll('col')).map(
    (col) => col.getAttribute('class') || null,
  );
}

const EVERY_TABLE: [LineTableColumns, LineTableMode][] = [
  ['timeEntry', 'read'],
  ['timeEntry', 'edit'],
  ['amount', 'read'],
  ['amount', 'edit'],
];

describe('lineTableCls', () => {
  it.each(EVERY_TABLE)('turns off content-driven sizing for %s/%s', (columns, mode) => {
    // Without this a colgroup is only a suggestion: an auto-layout table still
    // widens a column to fit a longer figure.
    expect(lineTableCls(columns, mode)).toContain('table-fixed');
  });

  it.each(EVERY_TABLE)('floors %s/%s at its columns plus room for prose', (columns, mode) => {
    // The minimum is spelled out rather than computed, because Tailwind reads
    // source text. This is what keeps the two in step: change a column width
    // above and the arithmetic here stops matching the class below.
    const expected = sizedWidth(columns, mode) + DESCRIPTION_FLOOR;

    expect(lineTableCls(columns, mode)).toContain(`min-w-[${expected}px]`);
  });

  it('asks more of the editor than of the read view', () => {
    // The editor's row carries a rate box, two steppers and a remove button
    // where the read view prints three short strings.
    expect(sizedWidth('timeEntry', 'edit')).toBeGreaterThan(sizedWidth('timeEntry', 'read'));
  });
});

describe('TimeEntryCols', () => {
  it('leaves the description unsized so it takes the remainder', () => {
    const { container } = render(
      <table>
        <TimeEntryCols mode="read" />
      </table>,
    );

    expect(widths(container)[0]).toBeNull();
  });

  it('sizes the rate, hours and amount columns in read mode', () => {
    const { container } = render(
      <table>
        <TimeEntryCols mode="read" />
      </table>,
    );

    expect(widths(container)).toEqual([null, 'w-32', 'w-28', 'w-36']);
  });

  it('widens only the hours column for the editor, and adds one for the remove button', () => {
    // The rate and amount columns keep their read-mode widths on purpose, so
    // entering edit mode does not slide the figures sideways.
    const { container } = render(
      <table>
        <TimeEntryCols mode="edit" />
      </table>,
    );

    expect(widths(container)).toEqual([null, 'w-32', 'w-[272px]', 'w-36', 'w-14']);
  });
});

describe('AmountCols', () => {
  it('gives its money column the same width the time entry table uses', () => {
    // Flat fees, expenses and adjustments stack under the time entries on one
    // panel. A different width here would step the figures in and out down the
    // page.
    const amount = render(
      <table>
        <AmountCols mode="read" />
      </table>,
    );
    const timeEntry = render(
      <table>
        <TimeEntryCols mode="read" />
      </table>,
    );

    const amountWidths = widths(amount.container);
    const timeEntryWidths = widths(timeEntry.container);
    expect(amountWidths[amountWidths.length - 1]).toBe(
      timeEntryWidths[timeEntryWidths.length - 1],
    );
  });

  it('leaves the description unsized and adds a column for the remove button in the editor', () => {
    const { container } = render(
      <table>
        <AmountCols mode="edit" />
      </table>,
    );

    expect(widths(container)).toEqual([null, 'w-36', 'w-14']);
  });
});
