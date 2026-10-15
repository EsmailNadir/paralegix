import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SignatureAnnotation from '@/components/signaturesComp/SignatureAnnotation';
import TextAnnotation from '@/components/signaturesComp/TextAnnotation';

jest.mock('@/components/signaturesComp/SignatureVisual', () => ({ __esModule: true, default: () => null }));

function pointer(target: Element | Window, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
  fireEvent(target, event);
}

afterEach(() => jest.restoreAllMocks());

it('edits existing annotation text with Enter and returns to its geometry surface with Escape', async () => {
  const onTextChange = jest.fn();
  const annotation = { id: 'text-a', type: 'text' as const, xPercent: 10, yPercent: 20, widthPercent: 30, heightPercent: 10, text: 'Original annotation', fontFamily: 'Arial', fontSize: 12, page: 1, isBold: false, isItalic: false, color: '#000' };
  render(<TextAnnotation annotation={annotation} isSelected pageWidth={1000} pageHeight={500} onSelect={jest.fn()} onMove={jest.fn()} onResize={jest.fn()} onTextChange={onTextChange} onDelete={jest.fn()} />);
  const box = screen.getByRole('group', { name: 'Text annotation, page 1' });
  box.focus();
  fireEvent.keyDown(box, { key: 'Enter' });
  const editor = screen.getByRole('textbox', { name: 'Annotation text' });
  await waitFor(() => expect(editor).toHaveFocus());
  editor.innerHTML = 'Corrected annotation';
  fireEvent.input(editor);
  expect(onTextChange).toHaveBeenCalledWith('Corrected annotation');
  fireEvent.keyDown(editor, { key: 'Escape' });
  expect(box).toHaveFocus();
  expect(screen.queryByRole('textbox', { name: 'Annotation text' })).not.toBeInTheDocument();
});

it.each(['signature', 'text'] as const)('moves and resizes the existing %s annotation by keyboard within page bounds', kind => {
  const annotation = { id: 'a', xPercent: 69, yPercent: 89, widthPercent: 30, heightPercent: 10, text: 'Existing text', fontFamily: 'Arial', fontSize: 12, page: 1, isBold: false, isItalic: false, color: '#000', dataUrl: '' };
  const props = { isSelected: true, pageWidth: 1000, pageHeight: 500, onSelect: jest.fn(), onMove: jest.fn(), onResize: jest.fn(), onTextChange: jest.fn(), onDelete: jest.fn() };
  render(kind === 'signature' ? <SignatureAnnotation {...props} annotation={{ ...annotation, type: 'signature' }} /> : <TextAnnotation {...props} annotation={{ ...annotation, type: 'text' }} />);
  const box = screen.getByRole('group', { name: `${kind === 'signature' ? 'Signature' : 'Text'} annotation, page 1` });
  box.focus();
  expect(props.onSelect).toHaveBeenCalled();
  expect(box).toHaveAccessibleDescription(/arrow keys/i);
  fireEvent.keyDown(box, { key: 'ArrowRight', shiftKey: true });
  expect(props.onMove).toHaveBeenLastCalledWith(70, 89);
  fireEvent.keyDown(box, { key: 'ArrowDown', shiftKey: true });
  expect(props.onMove).toHaveBeenLastCalledWith(69, 90);
  fireEvent.keyDown(box, { key: 'ArrowRight', altKey: true, shiftKey: true });
  expect(props.onResize).toHaveBeenLastCalledWith(31, 10);
  fireEvent.keyDown(box, { key: 'ArrowDown', altKey: true, shiftKey: true });
  expect(props.onResize).toHaveBeenLastCalledWith(30, 11);
  expect(screen.getAllByRole('button')).toHaveLength(1);
});

it.each([['signature', 3], ['text', 5]] as const)(
  '%s dragging preserves the grab offset, clamps both edges, and resizing retains its minimum width',
  (kind, minimum) => {
    const onMove = jest.fn();
    const onResize = jest.fn();
    const annotation = { id: 'a', xPercent: 10, yPercent: 20, widthPercent: 30, heightPercent: 10, text: 'text', fontFamily: 'Arial', fontSize: 12, page: 1, isBold: false, isItalic: false, color: '#000', dataUrl: '' };
    const props = { annotation, isSelected: true, pageWidth: 1000, pageHeight: 500, onSelect: jest.fn(), onMove, onResize, onTextChange: jest.fn(), onDelete: jest.fn() };
    const { container, unmount } = render(<div>{kind === 'signature' ? <SignatureAnnotation {...props} annotation={{ ...annotation, type: 'signature' }} /> : <TextAnnotation {...props} annotation={{ ...annotation, type: 'text' }} />}</div>);
    const box = container.querySelector(`[data-annotation="${kind}"]`)!;
    jest.spyOn(box, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 100 } as DOMRect);
    jest.spyOn(box.parentElement!, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0 } as DOMRect);
    pointer(box, 'pointerdown', 120, 110);
    pointer(window, 'pointermove', 220, 160);
    expect(onMove).toHaveBeenLastCalledWith(20, 30);
    pointer(window, 'pointermove', -20, -20);
    expect(onMove).toHaveBeenLastCalledWith(0, 0);
    pointer(window, 'pointermove', 2000, 1000);
    expect(onMove).toHaveBeenLastCalledWith(70, 90);
    pointer(window, 'pointerup', 2000, 1000);
    pointer(box.lastElementChild!, 'pointerdown', 400, 150);
    pointer(window, 'pointermove', 100, 100);
    expect(onResize).toHaveBeenLastCalledWith(minimum, 2);
    pointer(window, 'pointerup', 100, 100);
    const count = onResize.mock.calls.length;
    pointer(window, 'pointermove', 700, 400);
    expect(onResize).toHaveBeenCalledTimes(count);
    unmount();
  },
);
