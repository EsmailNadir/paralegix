import { resolveUniquePath, resolveOwnedOrUniquePath, splitFileName } from '../../src/shared/storage/uniquePath';

function bucketWith(existing: string[]) {
  const paths = new Set(existing);
  return { file: (path: string) => ({ exists: async () => [paths.has(path)] as [boolean] }) };
}

/** A bucket whose occupied paths carry known size + custom metadata, for resolveOwnedOrUniquePath. */
function ownedBucketWith(existing: Record<string, { size: number; metadata?: Record<string, string> }>) {
  return {
    file: (path: string) => ({
      exists: async () => [Object.prototype.hasOwnProperty.call(existing, path)] as [boolean],
      getMetadata: async (): Promise<[{ size?: string | number; metadata?: Record<string, string> }]> => {
        const entry = existing[path];
        if (!entry) throw Object.assign(new Error('No such object'), { code: 404 });
        return [{ size: entry.size, metadata: entry.metadata || {} }];
      },
    }),
  };
}

describe('unique storage paths', () => {
  it('splits only the final extension and treats dotfiles as stems', () => {
    expect(splitFileName('brief.pdf')).toEqual({ stem: 'brief', ext: '.pdf' });
    expect(splitFileName('archive.tar.gz')).toEqual({ stem: 'archive.tar', ext: '.gz' });
    expect(splitFileName('.env')).toEqual({ stem: '.env', ext: '' });
    expect(splitFileName('README')).toEqual({ stem: 'README', ext: '' });
  });

  it('keeps an unoccupied name unchanged', async () => {
    await expect(resolveUniquePath(bucketWith([]), 'firm/general/', 'brief.pdf'))
      .resolves.toEqual({ path: 'firm/general/brief.pdf', name: 'brief.pdf' });
  });

  it('chooses the first available numeric suffix without overwriting files', async () => {
    await expect(resolveUniquePath(
      bucketWith(['firm/general/brief.pdf', 'firm/general/brief (1).pdf', 'firm/general/brief (3).pdf']),
      'firm/general/', 'brief.pdf',
    )).resolves.toEqual({ path: 'firm/general/brief (2).pdf', name: 'brief (2).pdf' });
  });

  it('handles dotfiles and names without extensions', async () => {
    await expect(resolveUniquePath(bucketWith(['firm/.env']), 'firm/', '.env'))
      .resolves.toEqual({ path: 'firm/.env (1)', name: '.env (1)' });
    await expect(resolveUniquePath(bucketWith(['firm/README']), 'firm/', 'README'))
      .resolves.toEqual({ path: 'firm/README (1)', name: 'README (1)' });
  });

  it('uses a timestamp fallback after all readable suffixes are occupied', async () => {
    const originalNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    const existing = ['firm/brief.pdf'];
    for (let n = 1; n <= 1000; n += 1) existing.push(`firm/brief (${n}).pdf`);
    try {
      await expect(resolveUniquePath(bucketWith(existing), 'firm/', 'brief.pdf'))
        .resolves.toEqual({ path: 'firm/brief (1700000000000).pdf', name: 'brief (1700000000000).pdf' });
    } finally {
      Date.now = originalNow;
    }
  });
});

describe('resolveOwnedOrUniquePath', () => {
  it('lands on the bare name when nothing occupies it, same as resolveUniquePath', async () => {
    await expect(resolveOwnedOrUniquePath(ownedBucketWith({}), 'firm/general/', 'brief.pdf', 'signedViaSession', 'sess-1'))
      .resolves.toEqual({ path: 'firm/general/brief.pdf', name: 'brief.pdf', reusedSizeBytes: null });
  });

  it('skips past a collision owned by someone else, same as resolveUniquePath', async () => {
    const bucket = ownedBucketWith({
      'firm/general/brief.pdf': { size: 999, metadata: { signedViaSession: 'sess-OTHER' } },
    });
    await expect(resolveOwnedOrUniquePath(bucket, 'firm/general/', 'brief.pdf', 'signedViaSession', 'sess-1'))
      .resolves.toEqual({ path: 'firm/general/brief (1).pdf', name: 'brief (1).pdf', reusedSizeBytes: null });
  });

  it('reuses its own prior attempt instead of filing a second copy', async () => {
    const bucket = ownedBucketWith({
      'firm/general/brief.pdf': { size: 4096, metadata: { signedViaSession: 'sess-1' } },
    });
    await expect(resolveOwnedOrUniquePath(bucket, 'firm/general/', 'brief.pdf', 'signedViaSession', 'sess-1'))
      .resolves.toEqual({ path: 'firm/general/brief.pdf', name: 'brief.pdf', reusedSizeBytes: 4096 });
  });

  it('finds its own attempt past an unrelated collision at the bare name', async () => {
    // The bare name is taken by an unrelated file (from before this session ever
    // ran), so the first attempt itself would have landed on "(1)". A retry must
    // still find that "(1)" object as its own, not stop at the unrelated "(0)".
    const bucket = ownedBucketWith({
      'firm/general/brief.pdf': { size: 999, metadata: { signedViaSession: 'sess-OTHER' } },
      'firm/general/brief (1).pdf': { size: 2048, metadata: { signedViaSession: 'sess-1' } },
    });
    await expect(resolveOwnedOrUniquePath(bucket, 'firm/general/', 'brief.pdf', 'signedViaSession', 'sess-1'))
      .resolves.toEqual({ path: 'firm/general/brief (1).pdf', name: 'brief (1).pdf', reusedSizeBytes: 2048 });
  });

  it('reports no reused size for the timestamp fallback, matching a fresh file', async () => {
    const originalNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    const existing: Record<string, { size: number; metadata?: Record<string, string> }> = {
      'firm/brief.pdf': { size: 1, metadata: { signedViaSession: 'sess-OTHER' } },
    };
    for (let n = 1; n <= 1000; n += 1) {
      existing[`firm/brief (${n}).pdf`] = { size: 1, metadata: { signedViaSession: 'sess-OTHER' } };
    }
    try {
      await expect(resolveOwnedOrUniquePath(ownedBucketWith(existing), 'firm/', 'brief.pdf', 'signedViaSession', 'sess-1'))
        .resolves.toEqual({ path: 'firm/brief (1700000000000).pdf', name: 'brief (1700000000000).pdf', reusedSizeBytes: null });
    } finally {
      Date.now = originalNow;
    }
  });
});
