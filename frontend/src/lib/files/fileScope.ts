/**
 * Which set of documents a file view is showing.
 *
 * Every files call used to carry `(matterId, taskId, clientId)` as three
 * independent nullable arguments, so the fact that they are alternatives - and
 * which one wins when more than one is present - lived only in the backend's
 * if/else and in each caller's memory. A union states it once, and the compiler
 * stops a caller passing a combination that means nothing.
 *
 * The one legitimate combination is a matter narrowed to one of its tasks: a
 * matter-linked task files its documents under the matter's prefix, so showing
 * just that task's is a filter over the matter rather than a different location.
 */
export type FileScopeType = 'matter' | 'task' | 'client' | 'firm';

export type FileScope =
  /** The firm's General Files. */
  | { type: 'firm' }
  /** One matter, optionally narrowed to a single matter-linked task. */
  | { type: 'matter'; matterId: string; taskId?: string | null }
  /** A standalone task's own documents. */
  | { type: 'task'; taskId: string }
  /** A client's file area. */
  | { type: 'client'; clientId: string };

export const FIRM_SCOPE: FileScope = { type: 'firm' };

export const matterScope = (matterId: string, taskId?: string | null): FileScope =>
  ({ type: 'matter', matterId, taskId: taskId || null });

export const taskScope = (taskId: string): FileScope => ({ type: 'task', taskId });

export const clientScope = (clientId: string): FileScope => ({ type: 'client', clientId });

/**
 * Build a scope from the loose ids a component happens to hold.
 *
 * Applies the same precedence the server does (matter > task > client >
 * general), so a surface that still carries three optional props resolves to
 * exactly the documents it addressed before.
 */
export function scopeFromIds(ids: {
  matterId?: string | null;
  taskId?: string | null;
  clientId?: string | null;
}): FileScope {
  if (ids.matterId) return matterScope(ids.matterId, ids.taskId);
  if (ids.taskId) return taskScope(ids.taskId);
  if (ids.clientId) return clientScope(ids.clientId);
  return FIRM_SCOPE;
}

/** The query/body parameters that name this scope to the backend. */
export function scopeParams(scope: FileScope): {
  matterId?: string;
  taskId?: string;
  clientId?: string;
} {
  switch (scope.type) {
    case 'matter':
      return scope.taskId
        ? { matterId: scope.matterId, taskId: scope.taskId }
        : { matterId: scope.matterId };
    case 'task':
      return { taskId: scope.taskId };
    case 'client':
      return { clientId: scope.clientId };
    case 'firm':
    default:
      return {};
  }
}

/**
 * A stable string for one scope, for React dependency arrays and cache keys.
 *
 * Effects keyed on the scope object alone re-run on every render, because a
 * scope built inline is a new object each time.
 */
export function scopeKey(scope: FileScope): string {
  const p = scopeParams(scope);
  return `${scope.type}:${p.matterId ?? ''}:${p.taskId ?? ''}:${p.clientId ?? ''}`;
}

/**
 * Whether files in this scope can be shared with the client portal.
 *
 * A matter and a task share with the clients on them; a client's own file area
 * shares with that client. The firm's General Files have no client to share
 * with, so the control is not offered there.
 */
export const canShareWithClient = (scope: FileScope): boolean => scope.type !== 'firm';

/**
 * The upload endpoint's name for this scope.
 *
 * A matter narrowed to one of its tasks uploads INTO that task, so the stored
 * objects carry its id and land in the task's view rather than loose in the
 * matter's. This is the one place a task outranks the matter it belongs to - 
 * listing goes the other way, because a matter's browser shows the matter.
 */
export function uploadContextFor(scope: FileScope): 'matter' | 'lawfirm' | 'task' | 'client' {
  switch (scope.type) {
    case 'matter': return scope.taskId ? 'task' : 'matter';
    case 'task': return 'task';
    case 'client': return 'client';
    case 'firm':
    default: return 'lawfirm';
  }
}
