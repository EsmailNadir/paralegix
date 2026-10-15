/**
 * UtbmsPickerModal, driven through the REAL catalog service against a fake transport.
 *
 * The picker is a thin configuration of `CatalogPickerModal`, and everything it
 * decides is a wire fact: which catalog slice to load (`codeType`), which adopt
 * endpoint the selection is posted to (charge codes for task codes, expense
 * categories for expense codes), and which ids travel in the body. None of that
 * is visible on screen, so a spec that only checks rendering cannot see any of it.
 *
 * `catalog.service` therefore runs for real and only `fetch` is faked, so the url,
 * the query string, the request body and the error branch are all assertable.
 */
jest.unmock('@/services/catalog.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import UtbmsPickerModal from '@/components/billingComp/UtbmsPickerModal';

const LAW_FIRM_ID = 'firm-1';
const UTBMS_TASK_URL = `/api/lawfirms/${LAW_FIRM_ID}/catalog/utbms?codeType=task`;
const UTBMS_EXPENSE_URL = `/api/lawfirms/${LAW_FIRM_ID}/catalog/utbms?codeType=expense`;
const CHARGE_CODES_ADOPT_URL = `/api/lawfirms/${LAW_FIRM_ID}/catalog/charge-codes/adopt`;
const EXPENSE_CATEGORIES_ADOPT_URL = `/api/lawfirms/${LAW_FIRM_ID}/catalog/expense-categories/adopt`;

const TASK_CODES = {
  utbmsCodes: [
    { id: 'code-1', code: 'A101', name: 'Plan and prepare for deposition', codeType: 'task' },
    { id: 'code-2', code: 'A102', name: 'Research fact issues', codeType: 'task' },
  ],
  totalItems: 2,
};

const EXPENSE_CODES = {
  utbmsCodes: [
    { id: 'exp-1', code: 'E101', name: 'Copying', codeType: 'expense' },
  ],
  totalItems: 1,
};

let api: ApiMock;
let onClose: jest.Mock;
let onAdopted: jest.Mock;

function renderPicker(codeType: 'task' | 'expense' = 'task') {
  return renderWithProviders(
    <UtbmsPickerModal
      open
      lawFirmId={LAW_FIRM_ID}
      codeType={codeType}
      title={codeType === 'task' ? 'Import UTBMS Task Codes' : 'Import UTBMS Expense Codes'}
      onClose={onClose}
      onAdopted={onAdopted}
    />,
  );
}

/** The catalog row for a code, which is an `li role="button"` rather than a `<button>`. */
function row(code: string, description: string) {
  return screen.getByRole('button', { name: `${code} ${description}` });
}

beforeEach(() => {
  onClose = jest.fn();
  onAdopted = jest.fn();
  api = installApiMock();
  // Exact rather than suffix: the whole point of the first case below is that
  // the picker asks for ONE code type, and a suffix route would answer a request
  // carrying any `codeType` at all.
  api.getExact(UTBMS_TASK_URL, TASK_CODES);
});

afterEach(() => {
  api.restore();
});

describe('loading the catalog', () => {
  it('asks for only the code type it was opened for', async () => {
    api.getExact(UTBMS_EXPENSE_URL, EXPENSE_CODES);

    renderPicker('expense');

    expect(await screen.findByText('Copying')).toBeInTheDocument();
    // Goes red if `codeType` stops reaching the query string: the expense picker
    // would then list the whole UTBMS catalog, task codes included.
    expect(api.callsTo('/catalog/utbms')).toHaveLength(1);
    expect(api.callsTo('/catalog/utbms')[0].query.codeType).toEqual(['expense']);
  });

  it('lists each code number beside its description', async () => {
    renderPicker();

    expect(await screen.findByText('A101')).toBeInTheDocument();
    expect(screen.getByText('Plan and prepare for deposition')).toBeInTheDocument();
    expect(screen.getByText('A102')).toBeInTheDocument();
    expect(screen.getByText('Research fact issues')).toBeInTheDocument();
  });

  it('shows the server reason when the catalog cannot be loaded', async () => {
    api.getExact(UTBMS_TASK_URL, { status: 500, body: { error: 'UTBMS catalog is unavailable' } });

    renderPicker();

    expect(await screen.findByRole('alert')).toHaveTextContent('UTBMS catalog is unavailable');
    // The empty-list copy alone would be indistinguishable from a firm that has
    // already imported everything, so the failure has to say so.
    expect(screen.getByText('No matching codes.')).toBeInTheDocument();
  });

  it('filters the loaded catalog down to the typed query', async () => {
    renderPicker();
    expect(await screen.findByText('A101')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Filter by code or description…'), {
      target: { value: 'research fact' },
    });

    expect(screen.queryByText('A101')).not.toBeInTheDocument();
    expect(screen.getByText('A102')).toBeInTheDocument();
    // Filter mode caches the catalog and narrows it locally; a refetch per
    // keystroke would be a different (and much worse) component.
    expect(api.callsTo('/catalog/utbms')).toHaveLength(1);
  });
});

describe('selecting codes', () => {
  it('keeps Import disabled until something is selected, then counts the selection', async () => {
    renderPicker();
    expect(await screen.findByText('A101')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(screen.getByText('0 selected')).toBeInTheDocument();

    fireEvent.click(row('A101', 'Plan and prepare for deposition'));
    expect(screen.getByRole('button', { name: 'Import 1' })).toBeEnabled();

    fireEvent.click(row('A102', 'Research fact issues'));
    expect(screen.getByRole('button', { name: 'Import 2' })).toBeEnabled();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('announces each row as a toggle so a screen reader can tell what is selected', async () => {
    renderPicker();
    const first = await screen.findByRole('button', { name: 'A101 Plan and prepare for deposition' });

    expect(first).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-pressed', 'true');
    // Selection is drawn with a background colour and a tick glyph, neither of
    // which a screen reader reads. Without aria-pressed the list is unusable.
    expect(row('A102', 'Research fact issues')).toHaveAttribute('aria-pressed', 'false');
  });

  it('deselects a row that is clicked again', async () => {
    renderPicker();
    const first = await screen.findByRole('button', { name: 'A101 Plan and prepare for deposition' });

    fireEvent.click(first);
    fireEvent.click(first);

    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(screen.getByText('0 selected')).toBeInTheDocument();
  });
});

describe('importing', () => {
  it('posts exactly the selected ids to the firm charge codes', async () => {
    api.postExact(CHARGE_CODES_ADOPT_URL, { message: 'Imported', requested: 1, adopted: 1, skipped: 0 });

    renderPicker();
    expect(await screen.findByText('A101')).toBeInTheDocument();

    fireEvent.click(row('A101', 'Plan and prepare for deposition'));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1' }));

    await waitFor(() => expect(api.callsTo('/catalog/charge-codes/adopt')).toHaveLength(1));
    // The unselected code must NOT be in the body. A selection bug that imports
    // the whole visible page looks identical on screen.
    expect(api.callsTo('/catalog/charge-codes/adopt')[0].body).toEqual({ utbmsCodeIds: ['code-1'] });
    await waitFor(() => expect(onAdopted).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('routes an expense picker to expense categories, never to charge codes', async () => {
    api.getExact(UTBMS_EXPENSE_URL, EXPENSE_CODES);
    api.postExact(EXPENSE_CATEGORIES_ADOPT_URL, { message: 'Imported', requested: 1, adopted: 1, skipped: 0 });

    renderPicker('expense');
    expect(await screen.findByText('Copying')).toBeInTheDocument();

    fireEvent.click(row('E101', 'Copying'));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1' }));

    await waitFor(() => expect(api.callsTo('/catalog/expense-categories/adopt')).toHaveLength(1));
    expect(api.callsTo('/catalog/expense-categories/adopt')[0].body).toEqual({ utbmsCodeIds: ['exp-1'] });
    // The two adopt endpoints write to different tables. Sending an expense code
    // to the charge-code endpoint would quietly fill the firm's task codes with
    // expense codes, and the modal would still say it succeeded.
    expect(api.callsTo('/catalog/charge-codes/adopt')).toHaveLength(0);
  });

  it('keeps the modal open and shows the reason when the import is refused', async () => {
    api.postExact(CHARGE_CODES_ADOPT_URL, {
      status: 403,
      body: { error: 'Your role cannot import charge codes' },
    });

    renderPicker();
    expect(await screen.findByText('A101')).toBeInTheDocument();

    fireEvent.click(row('A101', 'Plan and prepare for deposition'));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Your role cannot import charge codes');
    // Closing on a rejection is the silent-failure shape: the user would return
    // to a settings page that never gained the codes and be told nothing.
    expect(onClose).not.toHaveBeenCalled();
    expect(onAdopted).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Import 1' })).toBeEnabled();
  });

  it('closes without importing anything when Cancel is pressed', async () => {
    renderPicker();
    expect(await screen.findByText('A101')).toBeInTheDocument();

    fireEvent.click(row('A101', 'Plan and prepare for deposition'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.calls('POST')).toHaveLength(0);
    expect(onAdopted).not.toHaveBeenCalled();
  });
});
