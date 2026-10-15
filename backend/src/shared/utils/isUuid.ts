/**
 * Is this value a canonical UUID string?
 *
 * Its own module because nearly every repository needs it, while it used to
 * live on `SqlRepository` and importing it pulled that legacy base class into
 * 65 files that never extended it. That class is now deleted; this is where the
 * function lives.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: any): boolean => typeof v === 'string' && UUID_RE.test(v);
