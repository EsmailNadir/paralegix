const { isUuid } = require('../../shared/utils/isUuid');

export const BASE_FOLDER = 'lawfirmids';

export const FILE_CONTEXT_TYPES = {
  matter: 'matter',
  task: 'task',
  client: 'client',
  general: 'general',
};

export function contextToPrefix(context: any) {
  const base = `${BASE_FOLDER}/${context.lawFirmId}`;

  switch (context.type) {
    case FILE_CONTEXT_TYPES.matter:
      return `${base}/${context.entityId}/`;
    case FILE_CONTEXT_TYPES.task:
      return `${base}/tasks/${context.entityId}/`;
    case FILE_CONTEXT_TYPES.client:
      return `${base}/clients/${context.entityId}/`;
    case FILE_CONTEXT_TYPES.general:
      return `${base}/general/`;
    default:
      throw new Error(`Unknown file context type: ${context.type}`);
  }
}

/**
 * Resolve an object path to the browsable folder it is filed in, or null when it
 * is filed nowhere a person can reach.
 *
 * `contextToPrefix` says where the four filing locations live; this is the same
 * knowledge read backwards. It exists because more than one caller has to agree
 * on it: the signatures module both files an executed document into a
 * caller-supplied folder AND mirrors that document into the `files` table, and
 * those two decisions have to come from one parse or they can disagree.
 *
 * A path that resolves here is somewhere a firm member can browse to. A path
 * that does not is a system prefix (`signatures/`, `invoices/`, `signing-work/`),
 * a conversation folder (`messaging/`), or a shape nothing in the app produces.
 * Callers that accept a destination from a REQUEST must reject null rather than
 * defaulting to firm scope: filing into an unbrowsable prefix puts the bytes
 * somewhere their owner can neither see nor remove.
 *
 * Sub-folders do not change the answer — only the segments identifying the
 * owning entity are read — so `lawfirmids/{firm}/{matterId}/Contracts/Signed/`
 * is still that matter.
 *
 * @returns {{ scope: 'matter'|'task'|'client'|'firm', matterId?: string, taskId?: string, clientId?: string }|null}
 */
export function parseFilingPath(lawFirmId: string, objectPath: any) {
  if (!lawFirmId || !objectPath) return null;
  const prefix = `${BASE_FOLDER}/${lawFirmId}/`;
  const value = String(objectPath);
  if (!value.startsWith(prefix)) return null;

  const segments = value.slice(prefix.length).replace(/\/+$/, '').split('/');
  const [first, second] = segments;

  if (first === 'general') return { scope: 'firm' };
  if (first === 'tasks') return isUuid(second) ? { scope: 'task', taskId: second } : null;
  if (first === 'clients') return isUuid(second) ? { scope: 'client', clientId: second } : null;
  if (isUuid(first)) return { scope: 'matter', matterId: first };
  return null;
}

// The file-context type each browsable scope is addressed by, so a parsed
// location can be turned back into the prefix that owns it.
const SCOPE_CONTEXT_TYPE: any = {
  matter: FILE_CONTEXT_TYPES.matter,
  task: FILE_CONTEXT_TYPES.task,
  client: FILE_CONTEXT_TYPES.client,
  firm: FILE_CONTEXT_TYPES.general,
};

