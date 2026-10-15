import { fireEvent, screen, waitFor } from '@testing-library/react';

/** Supply image/canvas geometry that jsdom cannot decode or measure. */
export function installCropPreview() {
  const drawImage = jest.fn();
  jest.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
    return this.closest('[hidden], [inert]') ? null : document.body;
  });
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 500, bottom: 400, width: 500, height: 400, toJSON: () => ({}),
  });
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: jest.fn(), drawImage } as any);
  jest.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['png'], { type: 'image/png' })));
  return { drawImage };
}

export async function loadCropPreview(width = 500, height = 400) {
  const image = await screen.findByRole('img', { name: /preview/i });
  Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
  fireEvent.load(image);
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Resize crop/ })).toHaveLength(4));
  return screen.getByRole('img', { name: /preview/i });
}
