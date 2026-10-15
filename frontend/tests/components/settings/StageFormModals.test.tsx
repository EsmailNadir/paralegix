import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LeadStageFormModal from '@/components/settingsComp/LeadStageFormModal';
import MatterStageFormModal from '@/components/settingsComp/MatterStageFormModal';
import { DEFAULT_STAGE_COLOR, STAGE_COLORS } from '@/constants/stageColors';
import type { LeadStage, MatterStage, PracticeArea } from '@/types';

const practiceAreas = [{ id: 'area-1', name: 'Family law' }] as PracticeArea[];
const stage = { id: 'stage-1', name: 'Discovery', color: null, isClosed: true };

// Red if a wrapper drops its scope/parent/pipeline, submits to create while
// editing, or the shared form forgets to reseed or closes after a refused save.
describe.each(['lead', 'matter'] as const)('%s stage form', (kind) => {
  function setup(editing = false) {
    const onCreate = jest.fn().mockResolvedValue(undefined);
    const onUpdate = jest.fn().mockResolvedValue(undefined);
    const onClose = jest.fn();
    const props = { open: true, onCreate, onUpdate, onClose, presetParentStageId: 'parent-1' };
    const element = (open: boolean, id = 'stage-1') => kind === 'lead'
      ? <LeadStageFormModal {...props} open={open} editing={editing ? { ...stage, id, practiceAreaId: 'area-1' } as LeadStage : null} practiceAreas={practiceAreas} presetPracticeAreaId="area-1" lockScope />
      : <MatterStageFormModal {...props} open={open} editing={editing ? { ...stage, id } as MatterStage : null} pipelineId="pipeline-1" />;
    return { ...render(element(true)), element, onCreate, onUpdate, onClose };
  }

  it('creates a trimmed name with the correct parent and scope', async () => {
    const { onCreate, onUpdate, onClose } = setup();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: '  Intake  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create stage' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({
      name: 'Intake', color: DEFAULT_STAGE_COLOR, isClosed: false, parentStageId: 'parent-1',
      ...(kind === 'lead' ? { practiceAreaId: 'area-1' } : { pipelineId: 'pipeline-1' }),
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('updates the existing stage without sending creation-only fields', async () => {
    const { onCreate, onUpdate, onClose } = setup(true);
    expect(screen.getByLabelText('Name *')).toHaveValue('Discovery');
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: '  Closed  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // A lead stage's pipeline is fixed once created, so an edit never sends it.
    expect(onUpdate).toHaveBeenCalledWith('stage-1', {
      name: 'Closed', color: null, isClosed: true,
    });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('saves edits to the color and closed-state controls', async () => {
    const { onUpdate } = setup(true);
    fireEvent.click(screen.getByRole('switch', { name: 'Closed stage' }));
    fireEvent.click(screen.getByRole('button', { name: `Color ${STAGE_COLORS[1]}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('stage-1', {
      name: 'Discovery', color: STAGE_COLORS[1], isClosed: false,
    }));
  });

  it('retains the draft and reports a refused save', async () => {
    const { onCreate, onClose } = setup();
    onCreate.mockRejectedValueOnce(new Error('Stage name already exists'));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Intake' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create stage' }));
    expect(await screen.findByText('Stage name already exists')).toBeInTheDocument();
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Name *')).toHaveValue('Intake');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create stage' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledTimes(2);
  });

  it('seeds again on reopening and when the edited stage changes', async () => {
    const { rerender, element } = setup(true);
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Unsaved draft' } });
    rerender(element(true, 'stage-2'));
    expect(screen.getByLabelText('Name *')).toHaveValue('Discovery');
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Another draft' } });
    rerender(element(false, 'stage-2'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    rerender(element(true, 'stage-2'));
    expect(screen.getByLabelText('Name *')).toHaveValue('Discovery');
  });
});

it('creates a default lead stage with a null practice-area scope', async () => {
  const onCreate = jest.fn().mockResolvedValue(undefined);
  render(<LeadStageFormModal open editing={null} practiceAreas={practiceAreas} onClose={jest.fn()} onCreate={onCreate} onUpdate={jest.fn()} />);
  fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'New lead' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create stage' }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ name: 'New lead', color: DEFAULT_STAGE_COLOR, isClosed: false, parentStageId: null, practiceAreaId: null }));
});

it('shows an edited lead stage scope read-only, even without lockScope', async () => {
  const onUpdate = jest.fn().mockResolvedValue(undefined);
  const editing = { ...stage, practiceAreaId: 'area-1' } as LeadStage;
  render(<LeadStageFormModal open editing={editing} practiceAreas={practiceAreas} onClose={jest.fn()} onCreate={jest.fn()} onUpdate={onUpdate} />);

  // The backend refuses a pipeline move, so offering the picker on edit would
  // promise a change that cannot be saved.
  expect(screen.queryByRole('button', { name: /Applies to/ })).not.toBeInTheDocument();
  expect(screen.getByText('Family law')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
  expect(onUpdate.mock.calls[0][1]).not.toHaveProperty('practiceAreaId');
});

it('saves the practice-area scope selected in the lead dropdown', async () => {
  const onCreate = jest.fn().mockResolvedValue(undefined);
  render(<LeadStageFormModal open editing={null} practiceAreas={practiceAreas} onClose={jest.fn()} onCreate={onCreate} onUpdate={jest.fn()} />);
  fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'New lead' } });
  fireEvent.click(screen.getByRole('button', { name: /Applies to/ }));
  fireEvent.click(screen.getByRole('option', { name: 'Family law' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create stage' }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ name: 'New lead', color: DEFAULT_STAGE_COLOR, isClosed: false, parentStageId: null, practiceAreaId: 'area-1' }));
});
