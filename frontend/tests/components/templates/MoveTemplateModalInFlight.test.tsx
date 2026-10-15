/**
 * The template move dialog cannot be dismissed while a move is in flight.
 * Escape and the backdrop used to close it mid-move, so a refused move had no
 * dialog left to report into.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import MoveTemplateModal from '@/components/templatesComp/MoveTemplateModal';

function renderModal(moving: boolean) {
  const onClose = jest.fn();
  render(
    <MoveTemplateModal
      open
      templateName="Engagement letter"
      folders={[]}
      currentFolderId={null}
      moving={moving}
      onMove={jest.fn()}
      onClose={onClose}
    />,
  );
  return onClose;
}

function backdrop(): HTMLElement {
  return screen.getByRole('dialog').closest('.fixed')!.firstElementChild as HTMLElement;
}

it('ignores Escape and the backdrop while the move is in flight', () => {
  const onClose = renderModal(true);

  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(backdrop());

  expect(onClose).not.toHaveBeenCalled();
});

it('closes on Escape and the backdrop once nothing is moving', () => {
  const onClose = renderModal(false);

  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(backdrop());

  expect(onClose).toHaveBeenCalledTimes(2);
});
