/**
 * MatterStageBar, driven through the REAL matters and billing services against
 * a fake transport.
 *
 * The bar is the one control that moves a matter through its pipeline, and the
 * move has consequences beyond the stage itself: landing on an ending stage
 * offers to close the matter, which ends recurring billing plans and hides the
 * matter from open counts. So the assertions here are about the REQUEST the bar
 * sends, not just what it paints. Under `tests/setup.ts`'s service Proxy neither
 * the pipeline nor the update exists, so the whole bar renders as "no pipeline".
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import MatterStageBar from '@/components/matterComp/MatterStageBar';
import type { Matter, MatterStage, MatterStagePipeline } from '@/types';

const LAW_FIRM_ID = 'firm-1';
const MATTER_ID = 'matter-1';
const PIPELINES_URL = `/api/lawfirms/${LAW_FIRM_ID}/matter-stage-pipelines`;
const MATTER_URL = `/api/lawfirms/${LAW_FIRM_ID}/matters/${MATTER_ID}`;
const BILLING_BASE = `/api/lawfirms/${LAW_FIRM_ID}/billing`;

let api: ApiMock;

function stage(overrides: Partial<MatterStage> & Pick<MatterStage, 'id' | 'name' | 'sortOrder'>): MatterStage {
  return {
    pipelineId: 'pipe-1',
    isClosed: false,
    parentStageId: null,
    ...overrides,
  };
}

/** Intake -> Drafting -> Executed, where Executed is an ending stage. */
const LINEAR_PIPELINE: MatterStagePipeline = {
  id: 'pipe-1',
  name: 'Estate Pipeline',
  isDefault: true,
  stages: [
    stage({ id: 'stage-1', name: 'Intake', sortOrder: 0 }),
    stage({ id: 'stage-2', name: 'Drafting', sortOrder: 1, parentStageId: 'stage-1' }),
    stage({ id: 'stage-3', name: 'Executed', sortOrder: 2, parentStageId: 'stage-2', isClosed: true }),
  ],
};

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: MATTER_ID,
    lawFirmId: LAW_FIRM_ID,
    name: 'Estate Planning Matter',
    matterReferenceId: 'MAT-101',
    status: 'active',
    stagePipelineId: 'pipe-1',
    stageId: 'stage-1',
    createdAt: '2026-01-05T00:00:00.000Z',
    updatedAt: '2026-01-05T00:00:00.000Z',
    ...overrides,
  } as Matter;
}

/** The three lookups the close prompt runs before it lets a matter be closed. */
function stubUnbilledWork(work: {
  timeEntries?: unknown[];
  flatFees?: unknown[];
  invoices?: unknown[];
} = {}) {
  api.get(`${BILLING_BASE}/time-entries/matter/${MATTER_ID}`, { timeEntries: work.timeEntries ?? [] });
  api.get(`${BILLING_BASE}/flat-fees/matter/${MATTER_ID}`, { flatFees: work.flatFees ?? [] });
  api.get(`${BILLING_BASE}/invoices/matter/${MATTER_ID}`, { invoices: work.invoices ?? [] });
}

beforeEach(() => {
  api = installApiMock();
  api.getExact(PIPELINES_URL, { pipelines: [LINEAR_PIPELINE] });
});

afterEach(() => {
  api.restore();
});

describe('MatterStageBar', () => {
  it('walks the ancestor chain to build the path the matter has taken', async () => {
    renderWithProviders(
      <MatterStageBar lawFirmId={LAW_FIRM_ID} matter={matter({ stageId: 'stage-2' })} canEdit />,
    );

    // Intake is an ancestor of Drafting, so it is on the path even though the
    // matter never carried its id. Losing the parentStageId walk leaves the bar
    // showing only the current stage.
    const intake = await screen.findByRole('button', { name: 'Intake' });
    const drafting = screen.getByRole('button', { name: 'Drafting' });
    expect(intake.compareDocumentPosition(drafting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The current stage is not a way back to itself; its ancestors are.
    expect(drafting).toBeDisabled();
    expect(intake).toBeEnabled();
    // Executed is ahead of the matter, not behind it: it belongs in the advance
    // control, never in the completed path.
    expect(screen.queryByRole('button', { name: 'Executed' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Advance to Executed/ })).toBeInTheDocument();
  });

  it('sends the target stage id for this matter when the advance button is clicked', async () => {
    const user = userEvent.setup();
    api.putExact(MATTER_URL, { message: 'Matter updated' });
    const onChanged = jest.fn();

    renderWithProviders(
      <MatterStageBar lawFirmId={LAW_FIRM_ID} matter={matter()} canEdit onChanged={onChanged} />,
    );

    await user.click(await screen.findByRole('button', { name: /Advance to Drafting/ }));

    await waitFor(() => expect(api.callsTo(`/matters/${MATTER_ID}`)).toHaveLength(1));
    const [put] = api.callsTo(`/matters/${MATTER_ID}`);
    expect(put.method).toBe('PUT');
    // Only the stage moves. Sending anything else here would overwrite fields
    // the viewer never touched, and `putExact` means a wrong firm or matter in
    // the url is an unhandled request rather than a silent pass.
    expect(put.body).toEqual({ stageId: 'stage-2' });
    // The detail page reloads the matter off this, so a missing callback leaves
    // the rest of the screen showing the old stage.
    expect(onChanged).toHaveBeenCalled();
  });

  it('offers each outcome by name when the pipeline forks', async () => {
    api.getExact(PIPELINES_URL, {
      pipelines: [{
        ...LINEAR_PIPELINE,
        stages: [
          stage({ id: 'stage-1', name: 'Intake', sortOrder: 0 }),
          stage({ id: 'stage-settled', name: 'Settled', sortOrder: 1, parentStageId: 'stage-1', isClosed: true }),
          stage({ id: 'stage-trial', name: 'Trial', sortOrder: 2, parentStageId: 'stage-1' }),
        ],
      }],
    });

    renderWithProviders(<MatterStageBar lawFirmId={LAW_FIRM_ID} matter={matter()} canEdit />);

    // A fork drops the "Advance to <name>" phrasing for a shared label plus one
    // button per outcome, so neither branch reads as the default.
    expect(await screen.findByText('Advance to')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settled' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trial' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Advance to Settled/ })).not.toBeInTheDocument();
  });

  it('shows a matter on its ending stage as completed with nowhere left to advance', async () => {
    renderWithProviders(
      <MatterStageBar
        lawFirmId={LAW_FIRM_ID}
        matter={matter({ stageId: 'stage-3', status: 'closed' })}
        canEdit
      />,
    );

    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Advance to/ })).not.toBeInTheDocument();
    // The path is still walkable backwards, which is how a matter gets reopened.
    expect(screen.getByRole('button', { name: 'Intake' })).toBeEnabled();
  });

  it('degrades to a read-only tracker instead of a denial when the viewer cannot edit', async () => {
    renderWithProviders(
      <MatterStageBar lawFirmId={LAW_FIRM_ID} matter={matter({ stageId: 'stage-2' })} canEdit={false} />,
    );

    // Everything a viewer reads survives: the pipeline name and the full path.
    expect(await screen.findByText(/Estate Pipeline/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Intake' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drafting' })).toBeInTheDocument();
    // Every way to CHANGE the matter is gone, including moving back a stage.
    expect(screen.getByRole('button', { name: 'Intake' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Advance to/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Estate Pipeline/ })).not.toBeInTheDocument();
  });

  it('renders nothing for a read-only viewer of a matter with no pipeline', async () => {
    api.getExact(PIPELINES_URL, { pipelines: [] });

    const { container } = renderWithProviders(
      <MatterStageBar lawFirmId={LAW_FIRM_ID} matter={matter()} canEdit={false} />,
    );

    await waitFor(() => expect(api.callsTo('/matter-stage-pipelines')).toHaveLength(1));
    // A viewer who cannot assign a pipeline gets no empty-state nagging them to.
    expect(container.firstChild).toBeNull();
  });

  it('prompts to choose a pipeline when an editor opens a matter with none', async () => {
    api.getExact(PIPELINES_URL, { pipelines: [] });

    renderWithProviders(<MatterStageBar lawFirmId={LAW_FIRM_ID} matter={matter()} canEdit />);

    expect(await screen.findByText('No pipeline is assigned to this matter.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose pipeline/ })).toBeInTheDocument();
  });

  it('offers to close the matter when it lands on an ending stage, listing the work that would be buried', async () => {
    const user = userEvent.setup();
    api.putExact(MATTER_URL, { message: 'Matter updated' });
    stubUnbilledWork({
      timeEntries: [
        { id: 'te-1', hours: 2.5, billable: true },
        { id: 'te-2', hours: 1, billable: true },
        // A non-billable entry is not work anybody is owed for.
        { id: 'te-3', hours: 4, billable: false },
      ],
      flatFees: [{ id: 'ff-1', description: 'Filing', amount: 250 }],
    });

    renderWithProviders(
      <MatterStageBar lawFirmId={LAW_FIRM_ID} matter={matter({ stageId: 'stage-2' })} canEdit />,
    );

    await user.click(await screen.findByRole('button', { name: /Advance to Executed/ }));

    const dialog = await screen.findByRole('dialog');
    // Reaching an ending stage records the outcome; it must ASK before closing,
    // because closing ends recurring billing plans.
    expect(within(dialog).getByText('Mark matter as closed?')).toBeInTheDocument();
    // The straight quotes and the title-cased status are the literals the
    // component emits.
    expect(dialog).toHaveTextContent(
      'This matter reached "Executed", an ending stage of its pipeline, but its status is still Active.',
    );
    // 3.5h, not 7.5h: the non-billable entry is excluded.
    expect(dialog).toHaveTextContent('3.5h of unbilled time and $250.00 in unbilled flat fees');
  });

  it('flags a matter closed with unbilled work as payment ongoing, and stamps today as the close date', async () => {
    const user = userEvent.setup();
    api.putExact(MATTER_URL, { message: 'Matter updated' });
    stubUnbilledWork({ flatFees: [{ id: 'ff-1', description: 'Filing', amount: 250 }] });

    renderWithProviders(
      <MatterStageBar lawFirmId={LAW_FIRM_ID} matter={matter({ stageId: 'stage-2' })} canEdit />,
    );

    await user.click(await screen.findByRole('button', { name: /Advance to Executed/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog).toHaveTextContent('$250.00 in unbilled flat fees'));
    await user.click(within(dialog).getByRole('button', { name: 'Mark as closed' }));

    await waitFor(() => expect(api.callsTo(`/matters/${MATTER_ID}`)).toHaveLength(2));
    const close = api.callsTo(`/matters/${MATTER_ID}`)[1];
    // Computed independently of the component, in the local zone CI pins. A
    // close date derived from a UTC timestamp lands on the wrong day here.
    const today = new Date().toLocaleDateString('en-CA');
    expect(close.body).toEqual({
      status: 'closed',
      closeDate: today,
      // Defaults on when money is still owed: without it a closed matter with
      // unbilled work disappears from the views that would chase it.
      paymentOngoing: true,
    });
  });

  it('does not overwrite a close date the matter already carries', async () => {
    const user = userEvent.setup();
    api.putExact(MATTER_URL, { message: 'Matter updated' });
    stubUnbilledWork();

    renderWithProviders(
      <MatterStageBar
        lawFirmId={LAW_FIRM_ID}
        matter={matter({ stageId: 'stage-2', closeDate: '2026-02-01' })}
        canEdit
      />,
    );

    await user.click(await screen.findByRole('button', { name: /Advance to Executed/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Mark as closed' }));

    await waitFor(() => expect(api.callsTo(`/matters/${MATTER_ID}`)).toHaveLength(2));
    const close = api.callsTo(`/matters/${MATTER_ID}`)[1];
    // No closeDate key at all: an explicitly recorded date is not today's to
    // replace, and no unbilled work means no paymentOngoing decision was made.
    expect(close.body).toEqual({ status: 'closed' });
  });

  it('does not ask to close a matter that is already closed', async () => {
    const user = userEvent.setup();
    api.putExact(MATTER_URL, { message: 'Matter updated' });
    stubUnbilledWork();

    renderWithProviders(
      <MatterStageBar
        lawFirmId={LAW_FIRM_ID}
        matter={matter({ stageId: 'stage-2', status: 'closed' })}
        canEdit
      />,
    );

    await user.click(await screen.findByRole('button', { name: /Advance to Executed/ }));

    await waitFor(() => expect(api.callsTo(`/matters/${MATTER_ID}`)).toHaveLength(1));
    // `findByRole` rather than `queryByRole`: the prompt opens a tick after the
    // update resolves, so querying immediately would report its absence before
    // it had a chance to appear and pass no matter what the guard does.
    // The prompt exists to ask about a status change; a terminal status has
    // nothing left to ask, and re-prompting would re-stamp the close date.
    await expect(screen.findByRole('dialog')).rejects.toThrow();
    // The unbilled-work lookups only run for the prompt, so their absence is a
    // second, independent witness that the guard held.
    expect(api.callsTo(`/time-entries/matter/${MATTER_ID}`)).toHaveLength(0);
  });

  it('offers to reopen a matter moved back off its ending stage', async () => {
    const user = userEvent.setup();
    api.putExact(MATTER_URL, { message: 'Matter updated' });

    renderWithProviders(
      <MatterStageBar
        lawFirmId={LAW_FIRM_ID}
        matter={matter({ stageId: 'stage-3', status: 'closed' })}
        canEdit
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Drafting' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Reopen this matter?')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reopen matter' }));

    await waitFor(() => expect(api.callsTo(`/matters/${MATTER_ID}`)).toHaveLength(2));
    // Leaving the status and close date behind would contradict the stage the
    // matter now sits on, so both are cleared together.
    expect(api.callsTo(`/matters/${MATTER_ID}`)[1].body).toEqual({ status: 'active', closeDate: null });
    expect(
      await screen.findByText(/Matter reopened and set back to Active/),
    ).toBeInTheDocument();
  });

  it('surfaces a rejected stage change instead of showing it as applied', async () => {
    const user = userEvent.setup();
    api.putExact(MATTER_URL, { status: 403, body: { error: 'You do not have permission to update this matter' } });
    const onChanged = jest.fn();

    renderWithProviders(
      <MatterStageBar lawFirmId={LAW_FIRM_ID} matter={matter()} canEdit onChanged={onChanged} />,
    );

    await user.click(await screen.findByRole('button', { name: /Advance to Drafting/ }));

    expect(await screen.findByText(/You do not have permission to update this matter/)).toBeInTheDocument();
    // The refresh must not run on a failed write, or the page reports a move
    // the server refused.
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Advance to Drafting/ })).toBeEnabled();
  });
});
