/**
 * The fingerprint worker survives a production build.
 *
 * The worker's script is the SHA-256 hasher's own source, stringified, plus a
 * message loop that calls it. A minifier renames the function (to `a`, say)
 * and `toString()` then returns `function a() {...}`, so a loop that calls it
 * by its written name throws a ReferenceError on every file. Nothing breaks
 * visibly: the upload falls back to hashing on the main thread, and a
 * multi-gigabyte file freezes the tab while it does.
 *
 * Here the hasher's source is renamed the way a minifier would, and the
 * generated script has to hash with it anyway.
 */
jest.mock('@/lib/files/sha256', () => {
  const actual = jest.requireActual('@/lib/files/sha256');
  const source: string = actual.createSha256Hasher.toString();
  const renamed = new Function(`return (${source.replace(/^function\s+createSha256Hasher\b/, 'function a')});`)();
  return { ...actual, createSha256Hasher: renamed };
});

import { createSha256Hasher } from '@/lib/files/sha256';
import { fingerprintWorkerSource } from '@/lib/files/fileFingerprint';

/** Drive the generated source the way a real Worker global would. */
function runWorkerSource() {
  const posted: unknown[] = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const fakeSelf = {
    addEventListener(type: string, callback: (event: { data: unknown }) => void) {
      if (type === 'message') listeners.push(callback);
    },
    postMessage(message: unknown) { posted.push(message); },
  };
  new Function('self', fingerprintWorkerSource())(fakeSelf);
  return {
    posted,
    send: (data: unknown) => { for (const l of listeners) l({ data }); },
  };
}

it('hashes with a hasher whose source carries a minified name', async () => {
  // The rename took, or this proves nothing about a minified build.
  expect(createSha256Hasher.name).toBe('a');
  expect(createSha256Hasher.toString()).not.toMatch(/createSha256Hasher/);

  const { posted, send } = runWorkerSource();
  let thrown: unknown = null;
  try {
    send({ id: 1, blob: new Blob(['abc']), chunkSize: 2 });
  } catch (error) {
    thrown = error;
  }
  for (let tick = 0; tick < 200 && posted.length === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  expect(thrown).toBeNull();
  expect(posted).toEqual([{
    id: 1,
    fingerprint: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  }]);
});
