import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LogoCropModal from '@/components/settingsComp/LogoCropModal';
import { installCropPreview, loadCropPreview } from '../../support/cropPreview';

let preview: ReturnType<typeof installCropPreview>;
beforeEach(() => { preview = installCropPreview(); });
afterEach(() => jest.restoreAllMocks());

function renderCrop(onConfirm = jest.fn()) {
  render(<LogoCropModal isOpen imageSrc="blob:photo" fileName="portrait.jpg" title="Crop Photo" onClose={jest.fn()} onConfirm={onConfirm} />);
  return onConfirm;
}

it('moves and resizes a crop by keyboard and exports the selected image coordinates', async () => {
  const save = renderCrop();
  const image = await loadCropPreview();
  const move = screen.getByRole('group', { name: 'Move crop' });
  expect(move).toHaveAccessibleDescription(/arrow keys/i);
  expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  await userEvent.tab();
  expect(move).toHaveFocus();
  await userEvent.keyboard('{ArrowRight}{Shift>}{ArrowDown}{/Shift}');
  const corner = screen.getByRole('button', { name: 'Resize crop top left' });
  await userEvent.tab();
  expect(corner).toHaveFocus();
  await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowDown}');
  expect(screen.getByRole('status')).toHaveTextContent('Left 73, top 67, width 358, height 287 pixels');
  await userEvent.click(screen.getByRole('button', { name: 'Crop & Upload' }));
  expect(preview.drawImage).toHaveBeenCalledWith(image, 73, 67, 358, 287, 0, 0, 358, 287);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0]).toMatchObject({ name: 'portrait.png', type: 'image/png' });
});

it.each([
  ['top right', '{ArrowRight}', 70, 56, 361, 288],
  ['bottom left', '{ArrowLeft}', 69, 56, 361, 288],
  ['bottom right', '{ArrowDown}', 70, 56, 360, 289],
])('resizes the %s corner through the same geometry used by dragging', async (corner, keys, x, y, width, height) => {
  renderCrop();
  const image = await loadCropPreview();
  screen.getByRole('button', { name: `Resize crop ${corner}` }).focus();
  await userEvent.keyboard(keys as string);
  await userEvent.click(screen.getByRole('button', { name: 'Crop & Upload' }));
  expect(preview.drawImage).toHaveBeenCalledWith(image, x, y, width, height, 0, 0, width, height);
});

it('keeps keyboard crops inside the image and enforces the minimum crop size', async () => {
  renderCrop();
  const image = await loadCropPreview();
  screen.getByRole('group', { name: 'Move crop' }).focus();
  for (let step = 0; step < 8; step++) await userEvent.keyboard('{Shift>}{ArrowLeft}{ArrowUp}{/Shift}');
  expect(screen.getByRole('status')).toHaveTextContent('Left 0, top 0, width 360, height 288 pixels');
  screen.getByRole('button', { name: 'Resize crop top left' }).focus();
  for (let step = 0; step < 40; step++) await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
  await userEvent.click(screen.getByRole('button', { name: 'Crop & Upload' }));
  expect(preview.drawImage).toHaveBeenCalledWith(image, 320, 0, 40, 288, 0, 0, 40, 288);
});

it('focuses repeated canvas failures inside the dialog and preserves the crop for retry', async () => {
  const save = renderCrop();
  const image = await loadCropPreview();
  jest.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null).mockReturnValueOnce(null);
  for (let attempt = 0; attempt < 2; attempt++) {
    await userEvent.click(screen.getByRole('button', { name: 'Crop & Upload' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Your browser couldn't create the cropped logo");
    expect(alert.parentElement).toHaveFocus();
  }
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Crop & Upload' }));
  expect(preview.drawImage).toHaveBeenCalledWith(image, 70, 56, 360, 288, 0, 0, 360, 288);
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('announces and exports keyboard selection in source-image pixels when the preview is scaled', async () => {
  renderCrop();
  const image = await loadCropPreview(1000, 800);
  screen.getByRole('group', { name: 'Move crop' }).focus();
  await userEvent.keyboard('{ArrowRight}{Shift>}{ArrowDown}{/Shift}');
  expect(screen.getByRole('status')).toHaveTextContent('Left 142, top 132, width 720, height 576 pixels');
  await userEvent.click(screen.getByRole('button', { name: 'Crop & Upload' }));
  expect(preview.drawImage).toHaveBeenCalledWith(image, 142, 132, 720, 576, 0, 0, 720, 576);
});

it('announces the restored selection when Reset Crop follows a keyboard adjustment', async () => {
  renderCrop();
  const image = await loadCropPreview();
  screen.getByRole('group', { name: 'Move crop' }).focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(screen.getByRole('status')).toHaveTextContent('Left 71, top 56, width 360, height 288 pixels');
  await userEvent.click(screen.getByRole('button', { name: 'Reset Crop' }));
  expect(screen.getByRole('status')).toHaveTextContent('Left 70, top 56, width 360, height 288 pixels');
  await userEvent.click(screen.getByRole('button', { name: 'Crop & Upload' }));
  expect(preview.drawImage).toHaveBeenCalledWith(image, 70, 56, 360, 288, 0, 0, 360, 288);
});

// Breaks if the shared cropper stops focusing its own decode failure, which
// firm-logo editing relies on as much as the profile photo does.
it('announces and focuses an image that cannot be decoded', async () => {
  const save = renderCrop();
  fireEvent.error(await screen.findByRole('img', { name: /preview/i }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent("We couldn't load that image. Please choose another file.");
  await waitFor(() => expect(alert.parentElement).toHaveFocus());
  expect(save).not.toHaveBeenCalled();
});

// Breaks if the status region stops reporting the caller's upload, or keeps
// the last crop coordinates in place of it.
it('reports the caller upload in its status region while loading', async () => {
  const onConfirm = jest.fn();
  const { rerender } = render(<LogoCropModal isOpen imageSrc="blob:photo" fileName="logo.png" onClose={jest.fn()} onConfirm={onConfirm} />);
  await loadCropPreview();
  expect(screen.getByRole('status')).toHaveTextContent('Left 70, top 56, width 360, height 288 pixels');
  await userEvent.click(screen.getByRole('button', { name: 'Crop & Upload' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  rerender(<LogoCropModal isOpen imageSrc="blob:photo" fileName="logo.png" loading onClose={jest.fn()} onConfirm={onConfirm} />);
  expect(screen.getByRole('status')).toHaveTextContent(/^Uploading image$/);
  rerender(<LogoCropModal isOpen imageSrc="blob:photo" fileName="logo.png" loading={false} error="Upload failed" onClose={jest.fn()} onConfirm={onConfirm} />);
  expect(screen.getByRole('status')).toHaveTextContent(/^$/);
});
