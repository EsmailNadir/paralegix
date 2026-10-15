import type { DecodedIdToken } from 'firebase-admin/auth';
import type { Request, RequestHandler, Response } from 'express';

/**
 * A request that has already been through `verifyToken`.
 *
 * `src/types/express.d.ts` declares `user` on every `Request` as
 * `DecodedIdToken | null | undefined`, because `optionalVerifyToken` sets it to
 * null and an unauthenticated route never sets it at all. This narrows it to
 * present, which is true for anything mounted behind `verifyToken` and is what
 * lets a handler write `req.user.uid` without a non-null assertion.
 *
 * The other request augmentations (`tz`, `member`, `userData`, `adminUser`) come
 * through from that same declaration and stay optional here, since whether they
 * are populated depends on which middleware a given route mounts.
 *
 * `params` is narrowed to `Record<string, string>`. Express 5 types a route param
 * as `string | string[]` because a repeating wildcard segment can capture several
 * values, but this app declares no wildcard route: every param is a single
 * segment. Without the narrowing, passing `req.params.lawFirmId` to anything
 * typed `string` fails, and the fix at each call site would be a `String()` that
 * says nothing.
 */
export interface AuthedRequest extends Omit<Request<Record<string, string>>, 'user'> {
  user: DecodedIdToken;
}

/**
 * Wrap a route handler so it returns its response body instead of writing it.
 *
 * Before this, every one of the 558 handlers spelled out the same shape:
 *
 *     async (req: any, res: any) => {
 *       const result = await service.doThing({ lawFirmId: req.params.lawFirmId, ... });
 *       res.status(200).json(result);
 *     }
 *
 * Two things came with that. The status and the `.json` call were repeated at
 * every route, so a route that answered 200 where its siblings answered 201 was a
 * silent inconsistency rather than a visible argument. And `req` was annotated
 * `any` at all 558 of them, which is where most of this package's `any` count
 * came from: `req.params.lawFrimId` type-checked happily and returned undefined.
 *
 * `AuthedRequest` fixes the second, so a misspelled param is a compile error.
 *
 * No try/catch here on purpose. Express 5 forwards a rejected promise from an
 * async handler to the error middleware itself, and this wrapper returns one, so
 * a throwing service still reaches `errorHandler` with its status and code intact.
 *
 * A handler that needs the response object itself (a stream, a redirect, a file
 * download) takes `res` as its second argument and writes to it; returning
 * nothing after `res` has been written is fine, because the wrapper checks
 * `headersSent` before sending anything of its own.
 */
export function handler<T>(
  fn: (req: AuthedRequest, res: Response) => Promise<T> | T,
  status = 200,
): RequestHandler {
  return async (req, res) => {
    const result = await fn(req as AuthedRequest, res);
    if (res.headersSent) return;
    res.status(status).json(result);
  };
}
