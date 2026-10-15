/**
 * Shared cases for a data hook that is scoped to a firm (or a firm plus a
 * matter, client or thread): it must never show one scope's rows as another's,
 * and it must not send anything before its scope exists.
 *
 * Both are the same few lines in every hook suite, and the version that drifts
 * is the one that stops proving anything (an absence asserted before the
 * request it is about went out). So the sequence lives here once.
 */
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ApiMock } from './apiMock';
import { holdResponse } from './deferred';
import { createQueryWrapper } from './queryWrapper';

type Wrapper = React.ComponentType<{ children: React.ReactNode }>;

export interface ScopeSide<P> {
  /** Props the hook is rendered with for this scope. */
  props: P;
  /** The request this scope makes. Matched exactly unless `match: 'suffix'`. */
  url: string;
  /** What the server answers for this scope. */
  body: unknown;
  /** The row ids the hook must show once this scope's response lands. */
  ids: string[];
}

export interface ScopeIsolationCase<P, R> {
  title: string;
  api: () => ApiMock;
  useHook: (props: P) => R;
  /** Reads the ids of the rows the hook is currently showing. */
  ids: (result: R) => string[];
  a: ScopeSide<P>;
  b: ScopeSide<P>;
  /**
   * `pending`: A has resolved, the scope moves to B, and B is held back. A's
   * rows must not stand in for B's while B loads.
   *
   * `late`: A is held back, the scope moves to B and B resolves, then A's
   * stale response lands. It must not replace B's rows.
   */
  mode: 'pending' | 'late';
  match?: 'exact' | 'suffix';
  wrapper?: () => Wrapper;
  /** Extra assertions once the case has settled on B. */
  finally?: (result: R) => void;
}

function register(api: ApiMock, match: 'exact' | 'suffix', url: string, handler: unknown) {
  if (match === 'exact') api.getExact(url, handler as never);
  else api.get(url, handler as never);
}

export function itKeepsScopeIsolated<P, R>(c: ScopeIsolationCase<P, R>): void {
  it(c.title, async () => {
    const api = c.api();
    const match = c.match ?? 'exact';
    const held = holdResponse();
    const [heldSide, answeredSide] = c.mode === 'pending' ? [c.b, c.a] : [c.a, c.b];
    register(api, match, answeredSide.url, answeredSide.body);
    register(api, match, heldSide.url, held.handler);

    const { result, rerender } = renderHook((props: P) => c.useHook(props), {
      initialProps: c.a.props,
      wrapper: (c.wrapper ?? createQueryWrapper)(),
    });

    if (c.mode === 'pending') {
      await waitFor(() => expect(c.ids(result.current)).toEqual(c.a.ids));

      rerender(c.b.props);
      await held.untilRequested();

      // B is still in flight here. A's rows must not render as though they
      // belong to B while it loads.
      for (const id of c.a.ids) expect(c.ids(result.current)).not.toContain(id);

      await act(async () => {
        held.release(c.b.body);
      });
      await waitFor(() => expect(c.ids(result.current)).toEqual(c.b.ids));
    } else {
      await held.untilRequested();

      rerender(c.b.props);
      await waitFor(() => expect(c.ids(result.current)).toEqual(c.b.ids));

      await act(async () => {
        held.release(c.a.body);
      });
      expect(c.ids(result.current)).toEqual(c.b.ids);
    }

    c.finally?.(result.current);
  });
}

export interface NoScopeCase<R> {
  title: string;
  api: () => ApiMock;
  useHook: () => R;
  /** True once the hook has settled into its idle state. */
  settled: (result: R) => boolean;
  wrapper?: () => Wrapper;
  /** Extra assertions on the idle state. */
  finally?: (result: R) => void;
}

export function itSendsNothingWithoutScope<R>(c: NoScopeCase<R>): void {
  it(c.title, async () => {
    const { result } = renderHook(() => c.useHook(), { wrapper: (c.wrapper ?? createQueryWrapper)() });

    await waitFor(() => expect(c.settled(result.current)).toBe(true));
    expect(c.api().calls()).toEqual([]);
    c.finally?.(result.current);
  });
}
