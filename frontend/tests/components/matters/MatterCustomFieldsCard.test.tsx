/**
 * MatterCustomFieldsCard, driven through the REAL matters service against a
 * fake transport.
 *
 * The card reads firm-level field DEFINITIONS from one endpoint and the VALUES
 * off the matter prop, then pairs them by id. Almost everything that can go
 * wrong here is a pairing or filtering bug - a value shown under the wrong
 * label, an archived field still on screen, another practice area's field
 * leaking in - and none of it is visible under `tests/setup.ts`'s service Proxy,
 * which resolves `listFieldDefs` to `{}` so the card renders nothing at all.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { holdResponse } from '../../support/deferred';
import MatterCustomFieldsCard from '@/components/matterComp/MatterCustomFieldsCard';
import useMatterFieldDefs from '@/hooks/matterConfigHooks/useMatterFieldDefs';
import type { Matter, MatterFieldDef } from '@/types';

const LAW_FIRM_ID = 'firm-1';
const MATTER_ID = 'matter-1';
const FIELD_DEFS_URL = `/api/lawfirms/${LAW_FIRM_ID}/matter-field-defs`;
const MATTER_URL = `/api/lawfirms/${LAW_FIRM_ID}/matters/${MATTER_ID}`;

let api: ApiMock;

function fieldDef(overrides: Partial<MatterFieldDef> & Pick<MatterFieldDef, 'id' | 'label'>): MatterFieldDef {
  return {
    fieldType: 'text',
    options: [],
    required: false,
    sortOrder: 0,
    archived: false,
    ...overrides,
  };
}

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: MATTER_ID,
    lawFirmId: LAW_FIRM_ID,
    name: 'Corporate Dispute',
    status: 'active',
    matterReferenceId: 'MAT-1',
    createdAt: '2026-01-05T00:00:00.000Z',
    updatedAt: '2026-01-05T00:00:00.000Z',
    ...overrides,
  } as Matter;
}

/** The `<dd>` paired with a field's `<dt>`, so a value is asserted against ITS label. */
function valueFor(label: string): HTMLElement {
  const row = screen.getByText(label).parentElement as HTMLElement;
  const value = row.querySelector('dd');
  if (!value) throw new Error(`No value cell rendered beside "${label}"`);
  return value as HTMLElement;
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

describe('MatterCustomFieldsCard', () => {
  it('pairs each stored value with its own field definition and formats it by type', async () => {
    api.getExact(FIELD_DEFS_URL, {
      fieldDefs: [
        fieldDef({ id: 'field-1', label: 'Court Docket No', fieldType: 'text', sortOrder: 0 }),
        fieldDef({ id: 'field-2', label: 'Claim Amount', fieldType: 'currency', sortOrder: 1 }),
        fieldDef({ id: 'field-3', label: 'Filed On', fieldType: 'date', sortOrder: 2 }),
        fieldDef({ id: 'field-4', label: 'Jury Demanded', fieldType: 'checkbox', sortOrder: 3 }),
        fieldDef({
          id: 'field-5',
          label: 'Venue',
          fieldType: 'select',
          sortOrder: 4,
          options: [{ label: 'Superior Court', value: 'superior' }],
        }),
        fieldDef({ id: 'field-6', label: 'Local Counsel', fieldType: 'text', sortOrder: 5 }),
      ],
    });

    renderWithProviders(
      <MatterCustomFieldsCard
        lawFirmId={LAW_FIRM_ID}
        matter={matter({
          customFields: {
            'field-1': 'Case 12345',
            'field-2': 50000,
            'field-3': '2026-03-03',
            'field-4': false,
            'field-5': 'superior',
          },
        })}
        canEdit
      />,
    );

    expect(await screen.findByText('Custom Fields')).toBeInTheDocument();
    // Asserted through each label's OWN row: reading the values loose off the
    // page passes just as well when every value lands under one label.
    expect(valueFor('Court Docket No')).toHaveTextContent('Case 12345');
    expect(valueFor('Claim Amount')).toHaveTextContent('$50,000.00');
    // Day-only fields arrive as raw 'YYYY-MM-DD'. Parsing one as UTC midnight
    // renders the day before in America/Los_Angeles, which is what CI pins.
    expect(valueFor('Filed On')).toHaveTextContent('Mar 3, 2026');
    // A checkbox is never blank: an unticked box means No, not "unset".
    expect(valueFor('Jury Demanded')).toHaveTextContent('No');
    // A select shows the option's human label, not the stored value.
    expect(valueFor('Venue')).toHaveTextContent('Superior Court');
    expect(valueFor('Venue')).not.toHaveTextContent('superior');
    // A field the matter has no value for is a dash, not an empty cell.
    expect(valueFor('Local Counsel')).toHaveTextContent('-');
  });

  it('leaves out archived fields and other practice areas fields, in sort order', async () => {
    api.getExact(FIELD_DEFS_URL, {
      fieldDefs: [
        fieldDef({ id: 'field-b', label: 'Second Field', sortOrder: 2 }),
        fieldDef({ id: 'field-a', label: 'First Field', sortOrder: 1 }),
        fieldDef({ id: 'field-gone', label: 'Retired Field', sortOrder: 0, archived: true }),
        fieldDef({ id: 'field-other', label: 'Family Law Field', sortOrder: 0, practiceAreaId: 'pa-family' }),
        fieldDef({ id: 'field-mine', label: 'Litigation Field', sortOrder: 3, practiceAreaId: 'pa-litigation' }),
      ],
    });

    renderWithProviders(
      <MatterCustomFieldsCard
        lawFirmId={LAW_FIRM_ID}
        matter={matter({ practiceAreaId: 'pa-litigation' })}
        canEdit
      />,
    );

    await screen.findByText('First Field');
    // An archived definition is retired firm config; showing it puts a dead
    // field back on every matter.
    expect(screen.queryByText('Retired Field')).not.toBeInTheDocument();
    // A field scoped to another practice area does not belong on this matter.
    expect(screen.queryByText('Family Law Field')).not.toBeInTheDocument();
    expect(screen.getByText('Litigation Field')).toBeInTheDocument();

    const labels = screen.getAllByRole('term').map((dt) => dt.textContent);
    expect(labels).toEqual(['First Field', 'Second Field', 'Litigation Field']);
  });

  it('renders nothing when no definition applies to this matter', async () => {
    api.getExact(FIELD_DEFS_URL, {
      fieldDefs: [fieldDef({ id: 'field-gone', label: 'Retired Field', archived: true })],
    });

    const { container } = renderWithProviders(
      <MatterCustomFieldsCard lawFirmId={LAW_FIRM_ID} matter={matter()} canEdit />,
    );

    await waitFor(() => expect(api.callsTo('/matter-field-defs')).toHaveLength(1));
    // The whole card hides so the detail page does not carry an empty panel.
    expect(container.firstChild).toBeNull();
  });

  it('degrades to read-only rather than hiding the values when the viewer cannot edit', async () => {
    api.getExact(FIELD_DEFS_URL, {
      fieldDefs: [fieldDef({ id: 'field-1', label: 'Court Docket No' })],
    });

    renderWithProviders(
      <MatterCustomFieldsCard
        lawFirmId={LAW_FIRM_ID}
        matter={matter({ customFields: { 'field-1': 'Case 12345' } })}
        canEdit={false}
      />,
    );

    // Read-only means the record still reads, only the way in is gone. A denial
    // screen here, or a blank card, would both be wrong.
    expect(await screen.findByText('Custom Fields')).toBeInTheDocument();
    expect(valueFor('Court Docket No')).toHaveTextContent('Case 12345');
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
  });

  it('saves an edited field merged onto the values the matter already carries', async () => {
    const user = userEvent.setup();
    api.getExact(FIELD_DEFS_URL, {
      fieldDefs: [
        fieldDef({ id: 'field-1', label: 'Court Docket No', sortOrder: 0 }),
        fieldDef({ id: 'field-2', label: 'Claim Amount', fieldType: 'currency', sortOrder: 1 }),
      ],
    });
    api.putExact(MATTER_URL, { message: 'Matter updated' });
    const onSaved = jest.fn();

    renderWithProviders(
      <MatterCustomFieldsCard
        lawFirmId={LAW_FIRM_ID}
        matter={matter({
          customFields: {
            'field-1': 'Case 12345',
            'field-2': 50000,
            // A value whose definition is archived or scoped elsewhere is still
            // stored on the matter and must survive an edit of the visible ones.
            'field-hidden': 'keep me',
          },
        })}
        canEdit
        onSaved={onSaved}
      />,
    );

    await user.click(await screen.findByRole('button', { name: /edit/i }));
    const dialog = await screen.findByRole('dialog');
    const docketInput = within(dialog).getByDisplayValue('Case 12345');
    await user.clear(docketInput);
    await user.type(docketInput, 'Case 99999');
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(api.callsTo(`/matters/${MATTER_ID}`)).toHaveLength(1));
    const [put] = api.callsTo(`/matters/${MATTER_ID}`);
    expect(put.method).toBe('PUT');
    // The exact payload is the point: an edit that drops the untouched fields,
    // or replaces the stored map instead of merging onto it, erases data.
    expect(put.body).toEqual({
      customFields: {
        'field-1': 'Case 99999',
        'field-2': 50000,
        'field-hidden': 'keep me',
      },
    });
    expect(onSaved).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('blocks the save while a required field is empty', async () => {
    const user = userEvent.setup();
    api.getExact(FIELD_DEFS_URL, {
      fieldDefs: [fieldDef({ id: 'field-1', label: 'Court Docket No', required: true })],
    });

    renderWithProviders(
      <MatterCustomFieldsCard
        lawFirmId={LAW_FIRM_ID}
        matter={matter({ customFields: { 'field-1': 'Case 12345' } })}
        canEdit
      />,
    );

    await user.click(await screen.findByRole('button', { name: /edit/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Court Docket No *')).toBeInTheDocument();

    await user.clear(within(dialog).getByDisplayValue('Case 12345'));

    expect(within(dialog).getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    // Nothing was sent, so a required field cleared to empty cannot be saved.
    expect(api.callsTo(`/matters/${MATTER_ID}`)).toHaveLength(0);
  });
});

describe('MatterCustomFieldsCard after a definition changes', () => {
  // The settings screen's hook invalidates ["matterFieldDefs", firm] after every
  // create, update and delete. The card has to live under that key, or a field
  // added in settings stays missing from an open matter until a reload.
  function SettingsProbe() {
    const { createFieldDef } = useMatterFieldDefs(LAW_FIRM_ID);
    return (
      <button type="button" onClick={() => { void createFieldDef({ label: 'Opposing Counsel', fieldType: 'text' }); }}>
        add field
      </button>
    );
  }

  it('shows a field created through the settings hook', async () => {
    let created = false;
    api.getExact(FIELD_DEFS_URL, () => ({
      fieldDefs: [
        fieldDef({ id: 'field-1', label: 'Court Docket No' }),
        ...(created ? [fieldDef({ id: 'field-2', label: 'Opposing Counsel', sortOrder: 1 })] : []),
      ],
    }));
    // The settings hook's own list read, which asks for archived definitions too.
    api.getExact(`${FIELD_DEFS_URL}?includeArchived=true`, { fieldDefs: [] });
    api.postExact(FIELD_DEFS_URL, () => {
      created = true;
      return { fieldDef: fieldDef({ id: 'field-2', label: 'Opposing Counsel', sortOrder: 1 }) };
    });

    renderWithProviders(
      <>
        <MatterCustomFieldsCard lawFirmId={LAW_FIRM_ID} matter={matter()} canEdit />
        <SettingsProbe />
      </>,
    );
    await screen.findByText('Court Docket No');

    await userEvent.click(screen.getByRole('button', { name: 'add field' }));

    expect(await screen.findByText('Opposing Counsel')).toBeInTheDocument();
  });
});

describe('MatterCustomFieldsCard while the edit is saving', () => {
  // Red if: the edit dialog stays dismissible during the save (no
  // `dismissible={!submitting}`) or Cancel stays enabled, so Escape closes it
  // mid-save and a later failure renders into a closed dialog.
  it('keeps the dialog open until the save settles', async () => {
    const user = userEvent.setup();
    api.getExact(FIELD_DEFS_URL, {
      fieldDefs: [fieldDef({ id: 'field-1', label: 'Court Docket No', sortOrder: 0 })],
    });
    const put = holdResponse();
    api.putExact(MATTER_URL, put.handler);

    renderWithProviders(
      <MatterCustomFieldsCard
        lawFirmId={LAW_FIRM_ID}
        matter={matter({ customFields: { 'field-1': 'Case 12345' } })}
        canEdit
      />,
    );

    await user.click(await screen.findByRole('button', { name: /edit/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save Changes' }));
    await put.untilRequested();

    fireEvent.keyDown(document, { key: 'Escape' });
    // The card owns the open flag, so a close shows as the dialog unmounting
    // once its 100ms exit animation finishes. Wait past it before asserting.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await act(async () => put.release({ message: 'Matter updated' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
