import { customTokenSource } from '../../../scripts/stress-test/auth';

const firebaseReply = (idToken: string, expiresIn: string) =>
  new Response(JSON.stringify({ idToken, expiresIn }), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('customTokenSource', () => {
  let fetchSpy: jest.SpyInstance;
  afterEach(() => fetchSpy.mockRestore());

  it('signs in once and reuses the ID token while it has more than five minutes left', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(firebaseReply('id-1', '3600'));
    const mint = jest.fn().mockResolvedValue('custom-1');
    const source = customTokenSource('uid-1', 'key-1', mint);

    const tokens = await Promise.all([source.token(), source.token(), source.token()]);
    expect(tokens).toEqual(['id-1', 'id-1', 'id-1']);
    expect(await source.token()).toBe('id-1');
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith('uid-1');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=key-1');
    expect(JSON.parse(init.body)).toEqual({ token: 'custom-1', returnSecureToken: true });
  });

  it('signs in again once the token is inside the refresh margin', async () => {
    fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(firebaseReply('id-short', '60'))
      .mockResolvedValueOnce(firebaseReply('id-fresh', '3600'));
    const mint = jest.fn().mockResolvedValue('custom');
    const source = customTokenSource('uid-1', 'key-1', mint);

    expect(await source.token()).toBe('id-short');
    expect(await source.token()).toBe('id-fresh');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('surfaces the Firebase error message', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'INVALID_CUSTOM_TOKEN' } }), { status: 400 }),
    );
    const source = customTokenSource('uid-1', 'key-1', jest.fn().mockResolvedValue('bad'));
    await expect(source.token()).rejects.toThrow('Firebase sign-in for uid-1 failed: INVALID_CUSTOM_TOKEN');
  });
});
