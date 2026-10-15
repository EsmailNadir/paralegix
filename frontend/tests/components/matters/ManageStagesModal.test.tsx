/**
 * ManageStagesModal, driven through the REAL matters service against a fake transport.
 *
 * The modal reassigns a matter to a different stage pipeline. The load-bearing
 * part of that write is invisible: moving pipelines must also clear the matter's
 * current stage (`stageId: null`), because a stage id from the old pipeline does
 * not exist in the new one. A save that keeps the stage looks perfectly fine in
 * this dialog and leaves the matter pointing at a stage from another pipeline.
 *
 * So `matters.service` and `practiceArea.service` run for real, the two pipeline
 * hooks run for real on top of them, and only `fetch` is faked. Under the global
 * `tests/setup.ts` stubs the pipeline list would always be empty and the PUT body
 * would never be built at all.
 */
jest.unmock('@/services/matters.service');
jest.unmock('@/services/practiceArea.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';

import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { grantBaselineMember, resetPermissions } from '../../support/permissions';
import ManageStagesModal from '@/components/matterComp/ManageStagesModal';
import type { Matter } from '@/types';

const mockNavigate = jest.fn();
jest.mock('@/contexts/NavigationContext', () => ({
  __esModule: true,
  // A stable fn, unlike the global stub in `tests/setup.ts`, which hands out a
  // fresh `jest.fn()` per call so nothing it received can be asserted.
  useNavigation: () => ({ navigate: mockNavigate, isNavigating: false }),
}));

const LAW_FIRM_ID = 'firm-1';
const MATTER_ID = 'matter-1';
const PIPELINES_URL = `/api/lawfirms/${LAW_FIRM_ID}/matter-stage-pipelines`;
const PRACTICE_AREAS_URL = `/api/lawfirms/${LAW_FIRM_ID}/practice-areas`;
const MATTER_URL = `/api/lawfirms/${LAW_FIRM_ID}/matters/${MATTER_ID}`;

const MATTER: Matter = {
  id: MATTER_ID,
  lawFirmId: LAW_FIRM_ID,
  name: 'Acme v. Rival',
  matterReferenceId: 'MAT-1',
  status: 'active',
  stagePipelineId: 'pipe-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as Matter;

const PIPELINES = {
  pipelines: [
    {
      id: 'pipe-1',
      name: 'General Litigation',
      practiceAreaId: null,
      isDefault: true,
      stages: [
        { id: 'stage-1', pipelineId: 'pipe-1', name: 'Discovery', sortOrder: 0, isClosed: false },
        { id: 'stage-2', pipelineId: 'pipe-1', name: 'Trial', sortOrder: 1, isClosed: false },
      ],
    },
    {
      id: 'pipe-2',
      name: 'Corporate M&A',
      practiceAreaId: null,
      isDefault: false,
      stages: [
        { id: 'stage-3', pipelineId: 'pipe-2', name: 'Due Diligence', sortOrder: 0, isClosed: false },
      ],
    },
    {
      id: 'pipe-3',
      name: 'Employment Track',
      practiceAreaId: 'area-1',
      isDefault: false,
      stages: [],
    },
  ],
};

const PRACTICE_AREAS = { practiceAreas: [{ id: 'area-1', name: 'Employment' }] };

let api: ApiMock;
let onClose: jest.Mock;
let onChanged: jest.Mock;

function renderModal(matter: Matter = MATTER) {
  return renderWithProviders(
    <ManageStagesModal
      open
      onClose={onClose}
      lawFirmId={LAW_FIRM_ID}
      matter={matter}
      onChanged={onChanged}
    />,
  );
}

/** Open the pipeline dropdown and pick the option with this label. */
async function choosePipeline(label: string) {
  fireEvent.click(await screen.findByRole('button', { name: /^Pipeline/ }));
  fireEvent.click(screen.getByRole('option', { name: label }));
}

beforeEach(() => {
  mockNavigate.mockClear();
  onClose = jest.fn();
  onChanged = jest.fn();
  api = installApiMock();
  // Exact: every case here is tenant-scoped, and a suffix route would answer a
  // request for another firm's pipelines just as happily.
  api.getExact(PIPELINES_URL, PIPELINES);
  api.getExact(PRACTICE_AREAS_URL, PRACTICE_AREAS);
});

afterEach(() => {
  api.restore();
  resetPermissions();
});

describe('what the dialog shows', () => {
  it('waits for pipelines before showing the empty message', async () => {
    let releasePipelines: ((value: unknown) => void) | undefined;
    api.getExact(PIPELINES_URL, () => new Promise((resolve) => { releasePipelines = resolve; }));
    renderModal();

    await waitFor(() => expect(releasePipelines).toBeDefined());
    expect(screen.getByRole('status', { name: 'Loading matter pipelines' })).toBeInTheDocument();
    expect(screen.queryByText('No matter pipelines have been configured yet.')).not.toBeInTheDocument();

    releasePipelines?.({ pipelines: [] });
    expect(await screen.findByText('No matter pipelines have been configured yet.')).toBeInTheDocument();
  });

  it('opens on the pipeline the matter is already using and previews its stages', async () => {
    renderModal();

    // Anchored rather than exact: the shared Dropdown leaves its "▾" caret glyph
    // unhidden, so it trails the accessible name of every trigger in the app.
    expect(await screen.findByRole('button', { name: /^Pipeline Firm-wide · General Litigation/ }))
      .toBeInTheDocument();
    // The stages of pipe-1, not of the first pipeline in the list or of all of
    // them at once.
    expect(screen.getByText('Discovery')).toBeInTheDocument();
    expect(screen.getByText('Trial')).toBeInTheDocument();
    expect(screen.queryByText('Due Diligence')).not.toBeInTheDocument();
  });

  it('labels a practice-area pipeline with its area name, not the firm-wide prefix', async () => {
    renderModal();
    fireEvent.click(await screen.findByRole('button', { name: /^Pipeline/ }));

    // Two firms can both have an "Employment Track"; the area is what tells the
    // options apart, and it is resolved from a separate request.
    expect(screen.getByRole('option', { name: 'Employment · Employment Track' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Firm-wide · Employment Track' })).not.toBeInTheDocument();
  });

  it('swaps the stage preview when another pipeline is chosen', async () => {
    renderModal();
    await choosePipeline('Firm-wide · Corporate M&A');

    expect(screen.getByText('Due Diligence')).toBeInTheDocument();
    expect(screen.queryByText('Discovery')).not.toBeInTheDocument();
  });

  it('says so when the firm has no pipelines yet instead of offering an empty picker', async () => {
    api.getExact(PIPELINES_URL, { pipelines: [] });

    renderModal();

    expect(await screen.findByText('No matter pipelines have been configured yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pipeline/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use pipeline' })).toBeDisabled();
  });
});

describe('saving the new pipeline', () => {
  it('stays disabled while the matter current pipeline is still the selected one', async () => {
    renderModal();

    await screen.findByRole('button', { name: /^Pipeline/ });
    // Re-saving the same pipeline would clear the matter stage for no reason.
    expect(screen.getByRole('button', { name: 'Use pipeline' })).toBeDisabled();

    await choosePipeline('Firm-wide · Corporate M&A');
    expect(screen.getByRole('button', { name: 'Use pipeline' })).toBeEnabled();
  });

  it('writes the new pipeline and clears the stage, on this matter alone', async () => {
    api.putExact(MATTER_URL, { message: 'Matter updated' });

    renderModal();
    await choosePipeline('Firm-wide · Corporate M&A');
    fireEvent.click(screen.getByRole('button', { name: 'Use pipeline' }));

    await waitFor(() => expect(api.callsTo(`/matters/${MATTER_ID}`)).toHaveLength(1));
    const call = api.callsTo(`/matters/${MATTER_ID}`)[0];
    expect(call.method).toBe('PUT');
    // `stageId: null` is the whole point. Omitting it leaves the matter pointing
    // at `stage-1`, which belongs to a pipeline it no longer uses.
    expect(call.body).toEqual({ stagePipelineId: 'pipe-2', stageId: null });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open and shows the server reason when the write is refused', async () => {
    api.putExact(MATTER_URL, {
      status: 403,
      body: { error: 'You cannot change the pipeline of a closed matter' },
    });

    renderModal();
    await choosePipeline('Firm-wide · Corporate M&A');
    fireEvent.click(screen.getByRole('button', { name: 'Use pipeline' }));

    expect(await screen.findByRole('alert'))
      .toHaveTextContent('You cannot change the pipeline of a closed matter');
    // Closing here would tell the caller the matter moved and leave the parent
    // list rendering a pipeline the matter never got.
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Use pipeline' })).toBeEnabled();
  });

  it('closes without writing anything when Cancel is pressed', async () => {
    renderModal();
    await choosePipeline('Firm-wide · Corporate M&A');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.calls('PUT')).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('a member who cannot administer the firm', () => {
  beforeEach(() => grantBaselineMember());

  it('can still read the pipelines and move this matter between them', async () => {
    api.putExact(MATTER_URL, { message: 'Matter updated' });

    renderModal();
    // Degrade to read-only on the pipeline STRUCTURE, never a denial screen: the
    // stages stay visible and reassigning this one matter stays available.
    expect(await screen.findByText('Discovery')).toBeInTheDocument();

    await choosePipeline('Firm-wide · Corporate M&A');
    fireEvent.click(screen.getByRole('button', { name: 'Use pipeline' }));

    await waitFor(() => expect(api.callsTo(`/matters/${MATTER_ID}`)).toHaveLength(1));
  });

  it('is not offered the controls that edit the pipeline for every other matter', async () => {
    renderModal();
    await screen.findByText('Discovery');

    // Editing a stage rewrites it for every matter on the pipeline, and the
    // settings page it links to is itself gated on settings.manageFirm.
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage pipelines' })).not.toBeInTheDocument();
  });
});

describe('a member who can administer the firm', () => {
  it('is offered the pipeline editor and the deep link to firm settings', async () => {
    renderModal();
    await screen.findByText('Discovery');

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Manage pipelines' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    // The tab fragment matters: without it the settings page opens on its first
    // tab and the pipeline the user came to edit is not on screen.
    expect(mockNavigate).toHaveBeenCalledWith(`/lawfirm/${LAW_FIRM_ID}/settings/matter-config?tab=stages`);
  });

  it('warns that editing shared stages changes them for every matter on the pipeline', async () => {
    renderModal();
    await screen.findByText('Discovery');

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(screen.getByText(/changes the "General Litigation" pipeline for every/))
      .toBeInTheDocument();
    // The escape hatch from that blast radius. Without it the only way to give
    // one matter its own stages is to edit everyone else's.
    expect(screen.getByRole('button', { name: 'Duplicate for this matter' })).toBeInTheDocument();
  });
});

describe('duplicating a pipeline for this matter', () => {
  const COPY = {
    id: 'pipe-copy',
    name: 'General Litigation (copy)',
    practiceAreaId: null,
    isDefault: false,
    stages: [
      { id: 'stage-c1', pipelineId: 'pipe-copy', name: 'Discovery', sortOrder: 0, isClosed: false },
      { id: 'stage-c2', pipelineId: 'pipe-copy', name: 'Trial', sortOrder: 1, isClosed: false },
    ],
  };
  const COPY_URL = `${PIPELINES_URL}/pipe-copy`;

  /** The list grows the copy once the POST lands, the way the server's would. */
  function serveCopyAfterCreate() {
    let created = false;
    api.getExact(PIPELINES_URL, () => ({
      pipelines: created ? [...PIPELINES.pipelines, COPY] : PIPELINES.pipelines,
    }));
    api.postExact(PIPELINES_URL, () => {
      created = true;
      return { pipeline: COPY };
    });
  }

  async function createCopy() {
    renderModal();
    await screen.findByText('Discovery');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate for this matter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create copy' }));
    await waitFor(() => expect(api.calls('POST')).toHaveLength(1));
    // The editor switches to the copy once it exists.
    expect(await screen.findByRole('button', { name: /^Pipeline Firm-wide · General Litigation \(copy\)/ }))
      .toBeInTheDocument();
  }

  it('deletes the copy when the dialog is cancelled instead of assigning it', async () => {
    serveCopyAfterCreate();
    api.deleteExact(COPY_URL, { message: 'Pipeline deleted' });

    await createCopy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // The copy was made only for this matter. Walking away without assigning
    // it would leave an orphan pipeline in every other matter's picker.
    await waitFor(() => expect(api.calls('DELETE')).toHaveLength(1));
    expect(api.calls('DELETE')[0].pathname).toBe(COPY_URL);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.calls('PUT')).toHaveLength(0);
  });

  it('keeps the copy when it is assigned to the matter', async () => {
    serveCopyAfterCreate();
    api.putExact(MATTER_URL, { message: 'Matter updated' });

    await createCopy();
    fireEvent.click(screen.getByRole('button', { name: 'Use pipeline' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.callsTo(`/matters/${MATTER_ID}`)[0].body).toEqual({ stagePipelineId: 'pipe-copy', stageId: null });
    expect(api.calls('DELETE')).toHaveLength(0);
  });

  it('deletes the copy when a different pipeline is assigned instead', async () => {
    serveCopyAfterCreate();
    api.putExact(MATTER_URL, { message: 'Matter updated' });
    api.deleteExact(COPY_URL, { message: 'Pipeline deleted' });

    await createCopy();
    await choosePipeline('Firm-wide · Corporate M&A');
    fireEvent.click(screen.getByRole('button', { name: 'Use pipeline' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.callsTo(`/matters/${MATTER_ID}`)[0].body).toEqual({ stagePipelineId: 'pipe-2', stageId: null });
    expect(api.calls('DELETE').map((c) => c.pathname)).toEqual([COPY_URL]);
  });

  it('stays open with the reason when the copy cannot be removed', async () => {
    serveCopyAfterCreate();
    api.deleteExact(COPY_URL, { status: 500, body: { error: 'Could not delete pipeline' } });

    await createCopy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Closing here would hide that the copy is still on the server.
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete pipeline');
    expect(onClose).not.toHaveBeenCalled();
  });
});
