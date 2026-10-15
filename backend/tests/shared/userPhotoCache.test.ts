/**
 * The signed-URL cache in front of GCS, and what it must not do.
 *
 * Signing is a network round-trip, and a firm roster or a message list asks for
 * the same avatar once per row, so this cache is what keeps a list from signing
 * one photo fifty times. Two things about it were wrong.
 *
 * It was unbounded. The key is an object path plus a content version, so a
 * re-upload mints a key nobody asks for again. A 30 minute TTL removes such a
 * key only if something looks it up a second time, which is exactly what does
 * not happen, so the map grew for the life of the instance.
 *
 * And the URL it hands out expires. A cached entry served past its own life is
 * a broken image for the user, so the TTL is not merely a memory device here.
 */
const getSignedUrl = jest.fn();
const exists = jest.fn();
const file = jest.fn(() => ({ exists, getSignedUrl }));

jest.mock('../../src/shared/database/firebase', () => ({
  admin: { storage: () => ({ bucket: () => ({ file }) }) },
}));
jest.mock('../../src/shared/database/infrastructureQuery', () => ({
  infrastructureRootSql: jest.fn(async () => ({ rows: [] })),
  infrastructureSql: jest.fn(),
  withDrizzleTransaction: jest.fn(),
}));

import { signUserPhotoUrl, invalidatePhotoPrefix, userPhotoPrefix } from '../../src/shared/utils/userPhoto';

/** Answer every signing call with a distinct url, so a cache hit is visible. */
let signed = 0;
beforeEach(() => {
  signed = 0;
  jest.clearAllMocks();
  exists.mockResolvedValue([true]);
  getSignedUrl.mockImplementation(async () => { signed += 1; return [`https://signed/${signed}`]; });
  invalidatePhotoPrefix('users/');
  invalidatePhotoPrefix('lawfirms/');
});

describe('what it saves', () => {
  it('signs once and serves the same url again', async () => {
    const path = 'users/u1/avatar/a.png';

    const first = await signUserPhotoUrl(path, 100);
    const second = await signUserPhotoUrl(path, 100);

    expect(first).toBe(second);
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('re-signs when the content version changes', async () => {
    // Avatars reuse one object path, so without the version an instance that
    // did not serve the upload keeps returning the byte-identical old url and
    // the browser keeps showing the old picture.
    const path = 'users/u1/avatar/a.png';

    const before = await signUserPhotoUrl(path, 100);
    const after = await signUserPhotoUrl(path, 200);

    expect(after).not.toBe(before);
    expect(getSignedUrl).toHaveBeenCalledTimes(2);
  });

  it('returns null and caches nothing when the object is missing', async () => {
    exists.mockResolvedValue([false]);

    expect(await signUserPhotoUrl('users/u1/avatar/gone.png', 1)).toBeNull();
    // A miss must not be remembered as a url. It also must not be remembered as
    // a null: the object appears the moment the upload lands.
    exists.mockResolvedValue([true]);
    expect(await signUserPhotoUrl('users/u1/avatar/gone.png', 1)).toBe('https://signed/1');
  });

  it('returns null rather than throwing when GCS fails', async () => {
    exists.mockRejectedValue(new Error('network'));

    // A roster of forty members must not fail because one avatar could not be
    // signed. The row renders without a picture.
    await expect(signUserPhotoUrl('users/u1/avatar/a.png', 1)).resolves.toBeNull();
  });
});

describe('invalidation', () => {
  it('forgets every version under a prefix', async () => {
    // The key carries the version, so clearing must match the path portion or a
    // just-uploaded photo keeps serving the previous signature.
    await signUserPhotoUrl('users/u1/avatar/a.png', 100);
    await signUserPhotoUrl('users/u1/avatar/a.png', 200);

    invalidatePhotoPrefix(userPhotoPrefix('u1'));
    await signUserPhotoUrl('users/u1/avatar/a.png', 100);

    expect(getSignedUrl).toHaveBeenCalledTimes(3);
  });

  it('does not forget another user while forgetting one', async () => {
    await signUserPhotoUrl('users/u1/avatar/a.png', 1);
    await signUserPhotoUrl('users/u2/avatar/a.png', 1);

    invalidatePhotoPrefix(userPhotoPrefix('u1'));
    await signUserPhotoUrl('users/u2/avatar/a.png', 1);

    expect(getSignedUrl).toHaveBeenCalledTimes(2);
  });
});

describe('bounds', () => {
  it('re-signs once the cached url has aged out', async () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      await signUserPhotoUrl('users/u1/avatar/a.png', 1);

      // A signed url has its own expiry. Serving a cached one forever hands the
      // user a link GCS has stopped honouring.
      jest.setSystemTime(1_700_000_000_000 + 31 * 60 * 1000);
      await signUserPhotoUrl('users/u1/avatar/a.png', 1);

      expect(getSignedUrl).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops growing however many distinct photos are signed', async () => {
    // Ten thousand versioned keys, each signed once and never asked for again,
    // is the shape that made this grow for the life of the instance.
    for (let i = 0; i < 10_000; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential is the point
      await signUserPhotoUrl(`users/u${i}/avatar/a.png`, i);
    }

    // The earliest key must be gone, which is only observable as a re-sign.
    const before = getSignedUrl.mock.calls.length;
    await signUserPhotoUrl('users/u0/avatar/a.png', 0);
    expect(getSignedUrl.mock.calls.length).toBe(before + 1);
  });
});
