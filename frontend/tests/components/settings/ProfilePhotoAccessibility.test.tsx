jest.unmock('@/services/users.service');
jest.unmock('@/services/requestDeduplicator');

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProfilePhotoSection from '@/components/settingsComp/ProfilePhotoSection';
import { ProfileContext } from '@/contexts/ProfileContext';
import type { User } from '@/types';
import { setupApiMock, sequence } from '../../support/apiMock';
import { installXhrMock } from '../../support/xhrMock';
import { installCropPreview, loadCropPreview } from '../../support/cropPreview';
import { holdResponse } from '../../support/deferred';

const api = setupApiMock();
const profile = { name: 'Dana Client', email: 'dana@example.test', photoUrl: 'https://photos.test/original.png' } as User;
let xhr: ReturnType<typeof installXhrMock>;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
beforeEach(() => {
  installCropPreview();
  xhr = installXhrMock();
  URL.createObjectURL = jest.fn().mockReturnValue('blob:photo');
  URL.revokeObjectURL = jest.fn();
});
afterEach(() => {
  xhr.restore();
  jest.restoreAllMocks();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

function renderPhoto() { return render(<ProfileContext value={{ profile }}><ProfilePhotoSection /></ProfileContext>); }

async function choosePhoto(container: HTMLElement) {
  const trigger = screen.getByRole('button', { name: 'Change photo' });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const chooserOpened = jest.fn();
  input.addEventListener('click', chooserOpened);
  trigger.focus();
  await userEvent.keyboard('{Enter}');
  expect(chooserOpened).toHaveBeenCalledTimes(1);
  fireEvent.change(input, { target: { files: [new File(['image'], 'portrait.jpg', { type: 'image/jpeg' })] } });
  await loadCropPreview();
  return trigger;
}

it('focuses invalid-file feedback and returns to the photo chooser after dismissal', async () => {
  const { container } = renderPhoto();
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  screen.getByRole('button', { name: 'Change photo' }).focus();
  fireEvent.change(input, { target: { files: [new File(['pdf'], 'document.pdf', { type: 'application/pdf' })] } });
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('Invalid file type');
  expect(alert.parentElement).toHaveFocus();
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.getByRole('button', { name: 'Change photo' })).toHaveFocus();
  expect(api.calls()).toHaveLength(0);
});

it('keeps upload failures inside the crop dialog and completes a keyboard retry through storage', async () => {
  api.post('/users/me/photo/upload-init', sequence(
    { status: 503, body: { error: 'Photo service unavailable' } },
    { uploadUrl: 'https://storage.test/session', objectPath: 'users/dana/photo.png' },
  ));
  api.post('/users/me/photo/upload-finalize', { photoUrl: 'https://photos.test/updated.png' });
  xhr.onExact('PUT', 'https://storage.test/session', { status: 200 });
  const { container } = renderPhoto();
  const trigger = await choosePhoto(container);
  const dialog = screen.getByRole('dialog', { name: 'Crop Profile Picture' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Crop & Save' }));
  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveTextContent('Photo service unavailable');
  expect(alert.parentElement).toHaveFocus();
  expect(api.callsTo('/users/me/photo/upload-init')).toHaveLength(1);
  const save = within(dialog).getByRole('button', { name: 'Crop & Save' });
  save.focus();
  await userEvent.keyboard('{Enter}');
  expect(await screen.findByRole('status', { name: '' })).toHaveTextContent('Profile picture updated successfully!');
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(screen.getByRole('img', { name: 'Dana Client' })).toHaveAttribute('src', 'https://photos.test/updated.png');
  expect(xhr.calls()).toHaveLength(1);
  expect(api.callsTo('/users/me/photo/upload-finalize')[0].body).toEqual({ objectPath: 'users/dana/photo.png' });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:photo');
});

it('keeps removal refusal focus inside confirmation and restores focus after successful removal', async () => {
  api.delete('/users/me/photo', sequence({ status: 403, body: { error: 'Photo removal refused' } }, {}));
  renderPhoto();
  await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
  const dialog = screen.getByRole('dialog', { name: 'Remove Profile Picture' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveTextContent('Photo removal refused');
  expect(alert.parentElement).toHaveFocus();
  expect(api.callsTo('/users/me/photo')).toHaveLength(1);
  within(dialog).getByRole('button', { name: 'Remove' }).focus();
  await userEvent.keyboard('{Enter}');
  expect(await screen.findByRole('status')).toHaveTextContent('Profile picture removed successfully!');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Change photo' })).toHaveFocus());
  expect(api.callsTo('/users/me/photo')).toHaveLength(2);
  expect(screen.queryByRole('img', { name: 'Dana Client' })).not.toBeInTheDocument();
});

it('can focus file validation again after cancelling a refused removal', async () => {
  api.delete('/users/me/photo', { status: 403, body: { error: 'Photo removal refused' } });
  const { container } = renderPhoto();
  const remove = screen.getByRole('button', { name: 'Remove' });
  await userEvent.click(remove);
  const dialog = screen.getByRole('dialog', { name: 'Remove Profile Picture' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Photo removal refused');
  expect(api.callsTo('/users/me/photo')).toHaveLength(1);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(remove).toHaveFocus();
  screen.getByRole('button', { name: 'Change photo' }).focus();
  fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [new File(['pdf'], 'invalid.pdf', { type: 'application/pdf' })] } });
  expect(screen.getByRole('alert')).toHaveTextContent('Invalid file type');
  expect(screen.getByRole('alert').parentElement).toHaveFocus();
});

// Breaks if the chooser loses its aria-describedby link to the refusal, or if
// the refusal stops taking focus, for either client-side file check.
it.each([
  ['an unsupported type', new File(['pdf'], 'document.pdf', { type: 'application/pdf' }), 'Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed.'],
  ['an oversized image', new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' }), 'File size must be less than 5MB.'],
])('announces, focuses and ties %s refusal to the photo chooser', (_case, file, message) => {
  const { container } = renderPhoto();
  const trigger = screen.getByRole('button', { name: 'Change photo' });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(trigger).not.toHaveAccessibleDescription(/./);
  trigger.focus();
  fireEvent.change(input, { target: { files: [file] } });
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent(message);
  expect(alert.parentElement).toHaveFocus();
  expect(trigger).toHaveAccessibleDescription(expect.stringContaining(message));
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAccessibleDescription(expect.stringContaining(message));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(api.calls()).toHaveLength(0);
});

// Breaks if a decode failure stops rendering inside the crop dialog, stops
// taking focus, or if Crop & Save still sends an undecodable image upstream.
it('announces and focuses an image that cannot be decoded, without uploading', async () => {
  const { container } = renderPhoto();
  fireEvent.change(container.querySelector<HTMLInputElement>('input[type="file"]')!, {
    target: { files: [new File(['not really a jpeg'], 'broken.jpg', { type: 'image/jpeg' })] },
  });
  const dialog = screen.getByRole('dialog', { name: 'Crop Profile Picture' });
  fireEvent.error(within(dialog).getByRole('img', { name: /preview/i }));
  const alert = await within(dialog).findByRole('alert');
  expect(alert).toHaveTextContent("We couldn't load that image. Please choose another file.");
  await waitFor(() => expect(alert.parentElement).toHaveFocus());
  await userEvent.click(within(dialog).getByRole('button', { name: 'Crop & Save' }));
  expect(within(dialog).getByRole('alert')).toHaveTextContent("We couldn't prepare this image for cropping.");
  expect(api.calls()).toHaveLength(0);
});

// Breaks if the crop dialog's status region stops saying the upload started,
// keeps repeating crop coordinates over it, or if the finish is not announced.
it('announces once when the upload starts and once when it finishes', async () => {
  const init = holdResponse();
  api.post('/users/me/photo/upload-init', init.handler);
  api.post('/users/me/photo/upload-finalize', { photoUrl: 'https://photos.test/updated.png' });
  xhr.onExact('PUT', 'https://storage.test/session', { status: 200 });
  const { container } = renderPhoto();
  await choosePhoto(container);
  const dialog = screen.getByRole('dialog', { name: 'Crop Profile Picture' });
  within(dialog).getByRole('group', { name: 'Move crop' }).focus();
  await userEvent.keyboard('{ArrowRight}');
  const status = within(dialog).getByRole('status');
  expect(status).toHaveTextContent(/^Left \d+/);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Crop & Save' }));
  await init.untilRequested();
  expect(status).toHaveTextContent(/^Uploading image$/);
  expect(within(dialog).getByRole('button', { name: 'Crop & Save' })).toBeDisabled();
  await act(async () => init.release({ uploadUrl: 'https://storage.test/session', objectPath: 'users/dana/photo.png' }));
  expect(await screen.findByRole('status', { name: '' })).toHaveTextContent('Profile picture updated successfully!');
  expect(api.callsTo('/users/me/photo/upload-finalize')).toHaveLength(1);
});

// Breaks if a refused upload leaves "Uploading image" in the status region,
// which would tell a screen reader user the upload is still running.
it('clears the upload status when the upload is refused', async () => {
  api.post('/users/me/photo/upload-init', { status: 503, body: { error: 'Photo service unavailable' } });
  const { container } = renderPhoto();
  await choosePhoto(container);
  const dialog = screen.getByRole('dialog', { name: 'Crop Profile Picture' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Crop & Save' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Photo service unavailable');
  expect(api.callsTo('/users/me/photo/upload-init')).toHaveLength(1);
  expect(within(dialog).getByRole('status')).toHaveTextContent(/^$/);
});

// Breaks if any page-level error, not just a refused file, is wired to the
// chooser: a removal refusal says nothing about the file the user picks next.
it('does not describe the photo chooser with a removal refusal', async () => {
  api.delete('/users/me/photo', { status: 403, body: { error: 'Photo removal refused' } });
  renderPhoto();
  await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
  const dialog = screen.getByRole('dialog', { name: 'Remove Profile Picture' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Photo removal refused');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('alert')).toHaveTextContent('Photo removal refused');
  expect(screen.getByRole('button', { name: 'Change photo' })).not.toHaveAccessibleDescription(/./);
});
