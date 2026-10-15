/**
 * The file tree.
 *
 * A firm's documents are rows here, not object names in a bucket. `parent_id` is
 * the tree; the object under `lawfirmids/{law_firm_id}/objects/{id}` is written
 * once at upload and never moves. That is the whole design, and three things
 * follow from it:
 *
 *   - A rename or a move is one UPDATE. The old model copied every object under
 *     a prefix to a new prefix, one page at a time, and could stop halfway and
 *     leave a folder split across two locations.
 *   - Two people uploading the same filename into one folder cannot collide,
 *     because the unique index decides. The old resolver asked storage whether a
 *     path was free, and at that moment neither upload had written a byte, so
 *     both were handed the same path and one was silently replaced.
 *   - A folder is a row with `kind = 'folder'`. It used to be an empty `.folder`
 *     marker object whose custom metadata carried the folder's colour and share
 *     state, so a lost marker turned a folder into a file and orphaned its
 *     subtree.
 *
 * Every method here throws. Nothing is best-effort: this table IS the record, so
 * a write that cannot land has to fail the request that asked for it. The old
 * mirror swallowed its errors, which was survivable only while reads came from
 * the bucket.
 *
 * Recursive reads use `with recursive` and are bounded by the tree itself. There
 * is no scan ceiling, because there is no scan.
 */
const { infrastructureRootSql, infrastructureSql, withDrizzleTransaction } = require('../../shared/database/infrastructureQuery');
const { toIlikeTerm } = require('../../shared/database/searchTerm');
const { isUuid } = require('../../shared/utils/isUuid');
const { AppError, NotFoundError, ValidationError } = require('../../shared/errors/AppError');

/** Tries at a numbered name before falling back to a timestamp. */
const MAX_NAME_TRIES = 100;

/** Unique violation. The two indexes it can come from are told apart by name. */
const UNIQUE_VIOLATION = '23505';

async function run(executor: any, text: string, params: unknown[] = []) {
  const { rows } = executor
    ? await infrastructureSql(executor, text, params)
    : await infrastructureRootSql(text, params);
  return rows;
}

const COLUMNS = `id, law_firm_id, kind, name, parent_id, scope, matter_id, task_id, client_id,
  object_path, mime_type, size_bytes, finalized_at, uploaded_by, signed_via_session,
  client_visible, folder_color, deleted_at, deleted_by, created_at, updated_at`;

// The same list qualified for a join. Derived rather than written out twice: the
// recursive branch of a subtree walk has to select exactly the columns the base
// branch does, and a UNION whose two halves disagree is a runtime error, not a
// compile one. Spelling the list twice is how they drifted apart before.
const JOINED_COLUMNS = COLUMNS.replace(/\b(\w+)\b/g, 'f.$1');

type FileEntity = {
  id: string;
  lawFirmId: string;
  kind: 'file' | 'folder';
  name: string;
  parentId: string | null;
  scope: string;
  matterId: string | null;
  taskId: string | null;
  clientId: string | null;
  objectPath: string | null;
  mimeType: string | null;
  sizeBytes: number;
  finalizedAt: string | null;
  uploadedBy: string | null;
  signedViaSession: string | null;
  clientVisible: boolean;
  folderColor: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

function toEntity(r: any): FileEntity | null {
  if (!r) return null;
  const iso = (v: any) => (v instanceof Date ? v.toISOString() : v || null);
  return {
    id: r.id,
    lawFirmId: r.law_firm_id,
    kind: r.kind,
    name: r.name,
    parentId: r.parent_id || null,
    scope: r.scope,
    matterId: r.matter_id || null,
    taskId: r.task_id || null,
    clientId: r.client_id || null,
    objectPath: r.object_path || null,
    mimeType: r.mime_type || null,
    sizeBytes: r.size_bytes == null ? 0 : Number(r.size_bytes),
    finalizedAt: iso(r.finalized_at),
    uploadedBy: r.uploaded_by || null,
    signedViaSession: r.signed_via_session || null,
    clientVisible: r.client_visible === true,
    folderColor: r.folder_color || null,
    deletedAt: iso(r.deleted_at),
    deletedBy: r.deleted_by || null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/**
 * Split a filename so a numbered duplicate keeps its extension.
 *
 * "Brief.docx" has to become "Brief (1).docx", not "Brief.docx (1)": the second
 * does not open on a desktop. A leading dot is part of the name, not an
 * extension, so ".gitignore" stays whole.
 */
function splitName(name: string) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

function nameTaken(err: any) {
  const marker = `${err?.constraint || ''} ${err?.message || ''} ${err?.cause?.message || ''}`;
  return marker.includes('files_sibling_name');
}

function nameTakenError(name: string) {
  return new AppError(`Something named "${name}" is already here.`, 409, 'NAME_TAKEN');
}

/**
 * The subtree rooted at one row, as a CTE the caller can join against.
 *
 * Written once because five reads need it and a hand-rolled copy in each is how
 * they drift. `$1` is the firm and `$2` the starting row.
 */
/**
 * Rows one subtree page may hold, and the most a caller may ask for.
 *
 * The default is what a picker shows in one screenful with room to spare. The
 * maximum exists because `limit` comes from a caller: without it, asking for a
 * million rows is the unbounded read this replaced, spelled differently.
 */
const SUBTREE_DEFAULT_PAGE_SIZE = Number(process.env.FILES_SUBTREE_PAGE_SIZE) || 200;
const SUBTREE_MAX_PAGE_SIZE = 1000;

/**
 * The sort the browser displays: folders first, then by name.
 *
 * `id` is not decoration. Names are not unique across a subtree, so without it
 * two rows sort equally and the database may order them differently on each
 * query, which for a keyset means one row is served twice and the other never.
 *
 * The key is expressed ascending in all three parts so the page boundary is one
 * row comparison. Folders-first is `kind <> 'folder'`, which is false (and so
 * sorts first) exactly for folders.
 */
const SUBTREE_ORDER_KEY = `kind <> 'folder', lower(name), id`;
const SUBTREE_ORDER_BY = `kind <> 'folder' asc, lower(name) asc, id asc`;

/** Opaque page cursor. Encoded so no caller builds one by hand. */
function encodeSubtreeCursor(row: any): string {
  return Buffer.from(JSON.stringify([
    row.kind !== 'folder', String(row.name ?? '').toLowerCase(), row.id,
  ])).toString('base64url');
}

/**
 * Read a cursor back, or null.
 *
 * A malformed cursor restarts the walk rather than throwing. It arrives from a
 * client, so a stale bookmark or a truncated query string must not be a 500.
 */
function decodeSubtreeCursor(cursor: any): { folderFirst: boolean; name: string; id: string } | null {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const [folderFirst, name, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof folderFirst !== 'boolean' || typeof name !== 'string' || !isUuid(id)) return null;
    return { folderFirst, name, id };
  } catch {
    return null;
  }
}

const SUBTREE_CTE = `
  with recursive subtree as (
    select ${COLUMNS}, 0 as depth
      from files
     where law_firm_id = $1 and id = $2
    union all
    select ${JOINED_COLUMNS}, s.depth + 1
      from files f
      join subtree s on f.parent_id = s.id
     where f.law_firm_id = $1
  )`;

/**
 * The longest name a file or folder may carry.
 *
 * The database has the same limit as a CHECK, so nothing can write past it. This
 * is here to turn it into a sentence a person can act on rather than a 23514.
 *
 * The object path used to grow with the name and the whole folder chain above
 * it, so the real ceiling was the storage provider's 1024-byte object-name
 * limit, and how long a name could be depended on how deep its folder was. A
 * path is fixed length now, so the question is only whether the name is usable:
 * it is rendered in a listing, sent as a download filename, and written as a zip
 * entry.
 */
const MAX_NAME_LENGTH = 255;

function assertNameLength(name: any) {
  const value = String(name ?? '');
  if (value.length === 0) throw new ValidationError('A name is required');
  if (value.length > MAX_NAME_LENGTH) {
    throw new ValidationError('That name is too long. Shorten it and try again.');
  }
}

class FilesRepository {
  /**
   * The one root folder for a scope, creating it if this is the scope's first
   * write.
   *
   * `on conflict do nothing` then re-select, rather than select-then-insert:
   * several uploads can race to be the first file in a matter, and two roots
   * would split that matter's documents into two trees with neither able to see
   * the other. The partial unique indexes are what make the conflict fire.
   */
  async ensureScopeRoot(
    lawFirmId: string,
    { scope, matterId = null, taskId = null, clientId = null }: any,
    executor?: any,
  ): Promise<string> {
    if (!isUuid(lawFirmId)) throw new AppError('lawFirmId is required', 400, 'BAD_REQUEST');
    await run(executor,
      `insert into files (law_firm_id, kind, name, scope, matter_id, task_id, client_id)
       values ($1, 'folder', '', $2, $3, $4, $5)
       on conflict do nothing`,
      [lawFirmId, scope, matterId, taskId, clientId]);

    const rows = await run(executor,
      `select id from files
        where law_firm_id = $1 and parent_id is null and scope = $2
          and matter_id is not distinct from $3
          and task_id is not distinct from $4
          and client_id is not distinct from $5
        limit 1`,
      [lawFirmId, scope, matterId, taskId, clientId]);
    if (!rows[0]) throw new AppError('Could not resolve the file root', 500, 'ROOT_UNRESOLVED');
    return rows[0].id;
  }

  async findById(lawFirmId: string, fileId: any, { includeDeleted = false } = {}) {
    if (!isUuid(lawFirmId) || !isUuid(fileId)) return null;
    const rows = await run(null,
      `select ${COLUMNS} from files
        where law_firm_id = $1 and id = $2 ${includeDeleted ? '' : 'and deleted_at is null'}`,
      [lawFirmId, fileId]);
    return toEntity(rows[0]);
  }

  /**
   * Many live rows by id, in one query. Order is not preserved; callers that
   * care index the result by id.
   */
  async findManyByIds(lawFirmId: string, fileIds: any[]) {
    const ids = [...new Set((fileIds || []).filter(isUuid))];
    if (!isUuid(lawFirmId) || ids.length === 0) return [];
    const rows = await run(null,
      `select ${COLUMNS} from files
        where law_firm_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
      [lawFirmId, ids]);
    return rows.map(toEntity);
  }

  /**
   * The document a signing session already filed, if it filed one.
   *
   * Deleted rows included, on purpose. A session is filed once, and the unique
   * index on `signed_via_session` holds whether or not the firm has since
   * deleted the copy; a retry that could not see the deleted row would try to
   * file a second one and be refused by that index.
   */
  async findBySigningSession(lawFirmId: string, sessionId: any) {
    if (!isUuid(lawFirmId) || !sessionId) return null;
    const rows = await run(null,
      `select ${COLUMNS} from files
        where law_firm_id = $1 and signed_via_session = $2`,
      [lawFirmId, sessionId]);
    return toEntity(rows[0]);
  }

  async findByObjectPath(lawFirmId: string, objectPath: any, { includeDeleted = false } = {}) {
    if (!isUuid(lawFirmId) || !objectPath) return null;
    const rows = await run(null,
      `select ${COLUMNS} from files
        where law_firm_id = $1 and object_path = $2
          and ($3::boolean or deleted_at is null)`,
      [lawFirmId, objectPath, includeDeleted]);
    return toEntity(rows[0]);
  }

  /**
   * What a scope's whole subtree holds, read BEFORE its parent is deleted.
   *
   * Every one of `matter_id`, `task_id` and `client_id` carries an
   * `on delete cascade`, so deleting a matter takes its file rows with it. That
   * is what should happen, and it is also why a listener reacting to the delete
   * finds nothing left to count: by the time the event is emitted the rows are
   * gone. So the delete path takes this snapshot first and carries it on the
   * event, the same way it already snapshots the matter's tasks.
   *
   * Two things still need it. The stored objects have no foreign key to
   * anything and would otherwise sit in the bucket forever, and the firm's
   * running storage figure is what the upload quota gate reads, so a delete that
   * did not decrement it would cap the firm at a ceiling of documents they no
   * longer have.
   */
  async scopeSnapshot(lawFirmId: string, { matterId = null, taskId = null, clientId = null }: any) {
    const [column, value] = matterId
      ? ['matter_id', matterId]
      : taskId ? ['task_id', taskId]
        : clientId ? ['client_id', clientId] : [null, null];
    if (!isUuid(lawFirmId) || !column || !isUuid(value)) return { objects: [] };

    // Matched on the one column the cascade matches on, so this is exactly the
    // set that is about to disappear. A matter-linked task's document carries
    // BOTH `matter_id` and `task_id`, and deleting either parent takes it, so a
    // filter demanding the other column be null would miss it.
    const rows = await run(null,
      `select object_path, size_bytes, finalized_at, deleted_at
         from files where law_firm_id = $1 and ${column} = $2 and kind = 'file'`,
      [lawFirmId, value]);

    // One entry per object, each carrying what the firm is still being CHARGED
    // for it. The pairing is the point: the sweep credits a document's bytes
    // only when it actually removed that document's object, so a redelivered
    // event finds the objects already gone and credits nothing. A single total
    // could not tell a first delivery from a second.
    //
    // An unfinalized row was never charged and a soft-deleted one was already
    // credited back, so both carry zero. Their objects are still swept: an
    // unfinished upload's bytes are in the bucket too, and nothing else will
    // ever name them again.
    return {
      objects: rows.filter((r: any) => r.object_path).map((r: any) => ({
        objectPath: r.object_path,
        chargedBytes: r.finalized_at && !r.deleted_at ? Number(r.size_bytes || 0) : 0,
      })),
    };
  }

  /**
   * `scopeSnapshot` for many tasks in one query, keyed by task id.
   *
   * A bulk delete used to snapshot each task with its own query, all at once, so
   * a large selection took as many pool connections as it had tasks. Every
   * requested task gets an entry, `{ objects: [] }` when it has no documents, so
   * each task's TASK_DELETED event still carries exactly what `scopeSnapshot`
   * would have returned for it, including the charged-bytes rule described there.
   */
  async scopeSnapshotsForTasks(lawFirmId: string, taskIds: string[]) {
    const snapshots = new Map<string, { objects: Array<{ objectPath: string; chargedBytes: number }> }>();
    for (const id of taskIds || []) snapshots.set(id, { objects: [] });
    const ids = [...snapshots.keys()].filter(isUuid);
    if (!isUuid(lawFirmId) || ids.length === 0) return snapshots;

    const rows = await run(null,
      `select task_id, object_path, size_bytes, finalized_at, deleted_at
         from files where law_firm_id = $1 and task_id = any($2::uuid[]) and kind = 'file'`,
      [lawFirmId, ids]);

    for (const r of rows) {
      if (!r.object_path) continue;
      snapshots.get(r.task_id)?.objects.push({
        objectPath: r.object_path,
        chargedBytes: r.finalized_at && !r.deleted_at ? Number(r.size_bytes || 0) : 0,
      });
    }
    return snapshots;
  }

  /** The rows directly inside one folder, folders first then files, by name. */
  async listChildren(lawFirmId: string, folderId: any, { includeDeleted = false } = {}) {
    if (!isUuid(lawFirmId) || !isUuid(folderId)) return { folders: [], files: [] };
    const rows = await run(null,
      `select ${COLUMNS} from files
        where law_firm_id = $1 and parent_id = $2
          ${includeDeleted ? '' : 'and deleted_at is null'}
          -- An upload that never landed its bytes is not a document yet.
          and (kind = 'folder' or finalized_at is not null)
        order by kind = 'folder' desc, lower(name) asc`,
      [lawFirmId, folderId]);
    const all = rows.map(toEntity);
    return {
      folders: all.filter((r: any) => r.kind === 'folder'),
      files: all.filter((r: any) => r.kind === 'file'),
    };
  }

  /**
   * ONE PAGE of the descendants of a folder, flattened.
   *
   * What the file pickers read, and what both archive routes walk. The listing
   * above is one level, which is right for a browser and wrong for a picker: a
   * picker that could not reach a file two folders down could not be used to
   * attach it.
   *
   * There is deliberately no unpaged version. The read this replaced returned
   * every descendant row with every column and no limit, so its cost grew with
   * how long the customer had been using the product rather than with the
   * request, on the instance that also signs documents. A "return everything"
   * mode would be that read again with a different name.
   *
   * The page boundary is a KEYSET over the same order the browser displays, not
   * an offset. A folder is mutated constantly: uploads finalize, files are
   * deleted. With an offset, a row removed from an earlier page shifts every
   * later page back by one and exactly one row is never returned, which in a
   * picker is a document nobody can attach and nothing reports.
   *
   * @returns `{ rows, cursor }`. A null cursor means this was the last page.
   */
  async listSubtreePage(
    lawFirmId: string,
    folderId: any,
    { taskId = null, excludeTaskOwned = false, limit = SUBTREE_DEFAULT_PAGE_SIZE, cursor = null }: any = {},
  ) {
    if (!isUuid(lawFirmId) || !isUuid(folderId)) return { rows: [], cursor: null };

    const pageSize = Math.min(Math.max(Number(limit) || SUBTREE_DEFAULT_PAGE_SIZE, 1), SUBTREE_MAX_PAGE_SIZE);
    const params: any[] = [lawFirmId, folderId];

    let filter = '';
    if (taskId) {
      params.push(taskId);
      filter = ` and task_id = $${params.length}`;
    } else if (excludeTaskOwned) {
      // A matter-linked task's documents belong to the task. They would
      // otherwise fill the matter's own browser with every task's attachments.
      filter = ' and task_id is null';
    }

    let after = '';
    const from = decodeSubtreeCursor(cursor);
    if (from) {
      params.push(from.folderFirst, from.name, from.id);
      const n = params.length;
      // A row comparison over the SAME expressions the order uses. Written as
      // one comparison rather than the expanded OR chain because the two must
      // not drift: an order and a keyset that disagree skip rows silently.
      after = ` and (${SUBTREE_ORDER_KEY}) > ($${n - 2}, $${n - 1}, $${n}::uuid)`;
    }

    // One row past the page, so "is there more" needs no second query and no
    // count. The extra row is dropped before the caller sees it.
    params.push(pageSize + 1);
    const rows = await run(null,
      `${SUBTREE_CTE}
       select ${COLUMNS} from subtree
        where depth > 0 and deleted_at is null
          and (kind = 'folder' or finalized_at is not null)${filter}${after}
        order by ${SUBTREE_ORDER_BY}
        limit $${params.length}`,
      params);

    const page = rows.slice(0, pageSize).map(toEntity);
    const more = rows.length > pageSize;
    return { rows: page, cursor: more ? encodeSubtreeCursor(rows[pageSize - 1]) : null };
  }

  /**
   * `listSubtreePage` for SEVERAL matters, in ONE query, keyed by matter id.
   *
   * The same rows, in the same order, under the same filters as a matter's own
   * first page: a matter-linked task's documents belong to the task and are left
   * out, deleted rows and unlanded uploads are not documents, and the order is
   * the one the browser displays. What it does NOT do is page: a caller holding
   * a list of matters wants each matter's first page, and a cursor per matter is
   * a second dimension nothing asks for. Each matter is capped at `limit` and
   * says whether it was cut short, which is what the single route's `truncated`
   * means too.
   *
   * Every requested matter that HAS a tree gets an entry; one that has never had
   * a document is absent, and the caller answers for it with an empty page. That
   * is deliberate: a read must not create a scope root, which is a write, and
   * `ensureScopeRoot` per matter would put the per-matter round trips back.
   *
   * The walk is seeded with every matter's root at once and carries the matter
   * id down the recursion, the same shape `subtreeCounts` uses, so the cost is
   * one recursive pass over the requested trees rather than one pass per matter.
   * The per-matter cap is a window over that pass, so a firm with one enormous
   * matter cannot make the response grow with it.
   */
  async listSubtreePagesForMatters(
    lawFirmId: string,
    matterIds: string[],
    { limit = SUBTREE_DEFAULT_PAGE_SIZE }: any = {},
  ): Promise<Map<string, { rows: FileEntity[]; truncated: boolean }>> {
    const pages = new Map<string, { rows: FileEntity[]; truncated: boolean }>();
    const ids = [...new Set((matterIds || []).filter(isUuid))] as string[];
    if (!isUuid(lawFirmId) || ids.length === 0) return pages;

    const pageSize = Math.min(Math.max(Number(limit) || SUBTREE_DEFAULT_PAGE_SIZE, 1), SUBTREE_MAX_PAGE_SIZE);

    // One row past each matter's page, so "is there more" needs no second query
    // and no count, exactly as the single-matter read does it.
    const rows = await run(null,
      `with recursive roots as (
         select id, matter_id from files
          where law_firm_id = $1 and parent_id is null and scope = 'matter'
            and matter_id = any($2::uuid[])
       ), subtree as (
         select r.matter_id as root_matter_id, ${JOINED_COLUMNS}, 0 as depth
           from files f join roots r on r.id = f.id
          where f.law_firm_id = $1
         union all
         select s.root_matter_id, ${JOINED_COLUMNS}, s.depth + 1
           from files f join subtree s on f.parent_id = s.id
          where f.law_firm_id = $1
       ), ranked as (
         select root_matter_id, ${COLUMNS},
                row_number() over (
                  partition by root_matter_id order by ${SUBTREE_ORDER_BY}
                ) as rn
           from subtree
          where depth > 0 and deleted_at is null
            and (kind = 'folder' or finalized_at is not null)
            -- A matter-linked task's documents belong to the task, and would
            -- otherwise fill every matter's listing with task attachments.
            and task_id is null
       )
       select root_matter_id, ${COLUMNS} from ranked
        where rn <= $3
        order by root_matter_id, rn`,
      [lawFirmId, ids, pageSize + 1]);

    for (const row of rows) {
      const page = pages.get(row.root_matter_id)
        || { rows: [] as FileEntity[], truncated: false };
      if (page.rows.length < pageSize) page.rows.push(toEntity(row) as FileEntity);
      else page.truncated = true;
      pages.set(row.root_matter_id, page);
    }
    return pages;
  }

  /**
   * The standalone tasks attached to a client that hold anything, with the
   * number of live documents in each task's tree, ordered by title.
   *
   * Every row in a task's tree carries its `task_id`, so the count is a grouped
   * read rather than a walk. A matter-linked task is left out: its documents sit
   * in the matter's tree, and the client page reaches that matter separately.
   * An abandoned upload or a deleted row is not a document, and a task holding
   * nothing else is not listed.
   */
  async listClientTaskFileCounts(
    lawFirmId: string,
    clientId: string,
  ): Promise<{ id: string; title: string; fileCount: number }[]> {
    if (!isUuid(lawFirmId) || !isUuid(clientId)) return [];
    const rows = await run(null,
      `select t.id, t.title,
              (count(*) filter (where f.kind = 'file'))::int as file_count
         from task_clients tc
         join tasks t on t.law_firm_id = tc.law_firm_id and t.id = tc.task_id
         join files f on f.law_firm_id = t.law_firm_id and f.task_id = t.id
        where tc.law_firm_id = $1 and tc.client_id = $2
          and t.matter_id is null
          and f.scope = 'task' and f.parent_id is not null
          and f.deleted_at is null
          and (f.kind = 'folder' or f.finalized_at is not null)
        group by t.id, t.title
        order by lower(t.title), t.id`,
      [lawFirmId, clientId]);
    return rows.map((r: any) => ({ id: r.id, title: r.title, fileCount: r.file_count }));
  }

  /**
   * Every descendant, one page at a time, for a caller that covers all of them.
   *
   * The archive routes keep only the page being written, so their memory tracks
   * the page size rather than the folder size.
   *
   * This walks the tree folder by folder rather than paging `listSubtreePage`,
   * and the difference is not a detail. That function's recursive CTE expands
   * the WHOLE subtree and sorts it on every call, because a global name order
   * cannot be produced any other way. Paying that once per page makes a full
   * walk cost O(rows squared / page size): measured on a 20,000-row tree,
   * draining it that way took 2,146 ms against 109 ms for this walk.
   *
   * Here each folder is one index scan on `files_sibling_name_uidx`
   * (`law_firm_id, parent_id, lower(name)` where not deleted), keyset-paged so a
   * folder with twenty thousand children is still read in pages. Total work is
   * linear in the subtree and nothing is sorted.
   *
   * The order is depth-first, NOT the global name order `listSubtreePage`
   * returns. Both callers build a set, so neither depends on the order; a caller
   * that needs the displayed order wants the paged read instead.
   *
   * Descent follows live folders only, which is the same set the CTE reaches:
   * `softDeleteSubtree` marks a whole subtree at once and `restoreSubtree` has
   * no route, so a live row under a deleted parent cannot exist.
   *
   * Each row carries `relativePath`: its folder chain from `folderId`, exclusive
   * of that folder and including the row's own name. The walk already holds
   * every ancestor name on the way down, so this costs nothing. It replaces a
   * `ancestors()` call per file in the archive routes, which was one recursive
   * upward CTE per document: measured at 1,473 ms for 2,000 files, so roughly
   * 15 seconds of database time for a 20,000 document archive, with a pooled
   * connection held for all of it.
   */
  async *iterateSubtree(
    lawFirmId: string,
    folderId: any,
    { taskId = null, excludeTaskOwned = false, pageSize = SUBTREE_DEFAULT_PAGE_SIZE }: any = {},
  ) {
    if (!isUuid(lawFirmId) || !isUuid(folderId)) return;
    const size = Math.min(Math.max(Number(pageSize) || SUBTREE_DEFAULT_PAGE_SIZE, 1), SUBTREE_MAX_PAGE_SIZE);

    // A row is yielded only if it passes these, but descent follows every live
    // folder regardless. A task-owned FOLDER is hidden from a matter listing
    // while its contents are not, which is what the recursive read did.
    const yieldable = (row: any) => {
      if (row.kind !== 'folder' && !row.finalizedAt) return false;
      if (taskId) return String(row.taskId) === String(taskId);
      if (excludeTaskOwned) return !row.taskId;
      return true;
    };

    // Each entry is a folder still to visit plus the path that reaches it.
    const pending: Array<{ id: string; prefix: string }> = [{ id: folderId, prefix: '' }];
    while (pending.length) {
      const { id: parent, prefix } = pending.pop() as { id: string; prefix: string };
      let after: [string, string] | null = null;
      for (;;) {
        const params: any[] = [lawFirmId, parent];
        let keyset = '';
        if (after) {
          params.push(after[0], after[1]);
          keyset = ` and (lower(name), id) > ($${params.length - 1}, $${params.length}::uuid)`;
        }
        params.push(size);
        // Only `deleted_at is null` is in the WHERE, because that is the
        // predicate the index is partial on. The rest is applied above: pushing
        // it into SQL here would cost the index scan.
        // eslint-disable-next-line no-await-in-loop -- one page per folder is the point
        const rows = await run(null,
          `select ${COLUMNS} from files
            where law_firm_id = $1 and parent_id = $2 and deleted_at is null${keyset}
            order by lower(name) asc, id asc
            limit $${params.length}`,
          params);
        if (rows.length === 0) break;

        const entities = rows.map(toEntity);
        for (const row of entities) {
          row.relativePath = prefix ? `${prefix}/${row.name}` : String(row.name ?? '');
          if (row.kind === 'folder') pending.push({ id: row.id, prefix: row.relativePath });
        }
        const visible = entities.filter(yieldable);
        if (visible.length) yield visible;

        if (rows.length < size) break;
        const last = entities[entities.length - 1];
        after = [String(last.name ?? '').toLowerCase(), last.id];
      }
    }
  }

  /**
   * Recursive file and folder counts for a set of folders, in one query.
   *
   * The browser shows "Contracts, 14 files" without loading those files. Under
   * the old model this was the reason a listing walked the whole subtree.
   */
  async subtreeCounts(lawFirmId: string, folderIds: string[]) {
    const ids = (folderIds || []).filter(isUuid);
    if (!isUuid(lawFirmId) || ids.length === 0) return {};
    const rows = await run(null,
      `with recursive seeded as (
         select id as root_id, id, kind, deleted_at, finalized_at, size_bytes
           from files where law_firm_id = $1 and id = any($2::uuid[])
         union all
         select s.root_id, f.id, f.kind, f.deleted_at, f.finalized_at, f.size_bytes
           from files f join seeded s on f.parent_id = s.id
          where f.law_firm_id = $1
       )
       select root_id,
              count(*) filter (where id <> root_id and kind = 'file' and deleted_at is null and finalized_at is not null)::int as file_count,
              count(*) filter (where id <> root_id and kind = 'folder' and deleted_at is null)::int as folder_count,
              coalesce(sum(size_bytes) filter (where id <> root_id and kind = 'file' and deleted_at is null and finalized_at is not null), 0)::bigint as bytes
         from seeded
        group by root_id`,
      [lawFirmId, ids]);
    const out: Record<string, any> = {};
    for (const id of ids) out[id] = { fileCount: 0, folderCount: 0, bytes: 0 };
    for (const r of rows) {
      out[r.root_id] = {
        fileCount: Number(r.file_count),
        folderCount: Number(r.folder_count),
        bytes: Number(r.bytes),
      };
    }
    return out;
  }

  /**
   * What an export of these rows would transfer, in bytes, in one query.
   *
   * Each id may be a folder (everything live and finalized beneath it counts)
   * or a file (its own bytes count). A document reached twice, selected on its
   * own AND inside a selected folder, is counted once: the recursive `union`
   * drops the repeated row, the same way the archive writes it once.
   */
  async selectionBytes(lawFirmId: string, fileIds: string[]): Promise<number> {
    const ids = (fileIds || []).filter(isUuid);
    if (!isUuid(lawFirmId) || ids.length === 0) return 0;
    const rows = await run(null,
      `with recursive picked as (
         select id, kind, size_bytes, finalized_at
           from files
          where law_firm_id = $1 and id = any($2::uuid[]) and deleted_at is null
         union
         select f.id, f.kind, f.size_bytes, f.finalized_at
           from files f join picked p on f.parent_id = p.id
          where f.law_firm_id = $1 and f.deleted_at is null
       )
       select coalesce(sum(size_bytes), 0)::bigint as bytes
         from picked where kind = 'file' and finalized_at is not null`,
      [lawFirmId, ids]);
    return Number(rows[0]?.bytes || 0);
  }

  /**
   * Name search within one scope's subtree. Folders first, then files.
   *
   * The task-ownership split is applied HERE, before the limit, the same way
   * `listSubtreePage` applies it. Filtered afterwards, a limit could fill with
   * rows the caller is then denied and report fewer hits than exist.
   */
  async search(
    lawFirmId: string,
    rootId: any,
    queryText: any,
    { taskId = null, excludeTaskOwned = false, limit = null }: any = {},
  ) {
    const term = toIlikeTerm(queryText);
    if (!isUuid(lawFirmId) || !isUuid(rootId) || !term) return [];
    const params: any[] = [lawFirmId, rootId, term];
    let filter = '';
    if (taskId) {
      params.push(taskId);
      filter = ` and task_id = $${params.length}`;
    } else if (excludeTaskOwned) {
      filter = ' and task_id is null';
    }
    let bound = '';
    if (Number(limit) > 0) {
      params.push(Math.floor(Number(limit)));
      bound = ` limit $${params.length}`;
    }
    const rows = await run(null,
      `${SUBTREE_CTE}
       select ${COLUMNS} from subtree
        where depth > 0 and deleted_at is null
          and (kind = 'folder' or finalized_at is not null)
          and name ilike $3 escape '\\'${filter}
        order by kind = 'folder' desc, lower(name) asc, id asc${bound}`,
      params);
    return rows.map(toEntity);
  }

  /**
   * The chain from the scope root down to a row's parent, root first.
   *
   * Feeds breadcrumbs, the archive's directory names, and the visibility walk.
   */
  async ancestors(lawFirmId: string, fileId: any) {
    if (!isUuid(lawFirmId) || !isUuid(fileId)) return [];
    const rows = await run(null,
      `with recursive chain as (
         select ${COLUMNS}, 0 as up
           from files where law_firm_id = $1 and id = $2
         union all
         select ${JOINED_COLUMNS}, c.up + 1
           from files f join chain c on f.id = c.parent_id
          where f.law_firm_id = $1
       )
       select ${COLUMNS} from chain where up > 0 order by up desc`,
      [lawFirmId, fileId]);
    return rows.map(toEntity);
  }

  /**
   * `ancestors()` for many rows, in one query.
   *
   * Keyed by row id. Each chain is exactly what `ancestors()` returns for that
   * id: root first, the row itself excluded, deleted ancestors not filtered. An
   * id with no row maps to an empty chain. A listing that needs every row's path
   * calls this once instead of once per row, which held a pool connection per
   * document when the calls ran together.
   */
  async ancestorsForMany(lawFirmId: string, fileIds: any[]): Promise<Map<string, FileEntity[]>> {
    const ids = [...new Set((fileIds || []).filter(isUuid))] as string[];
    const chains = new Map<string, FileEntity[]>();
    for (const id of ids) chains.set(id, []);
    if (!isUuid(lawFirmId) || ids.length === 0) return chains;
    const rows = await run(null,
      `with recursive chain as (
         select ${COLUMNS}, id as origin_id, 0 as up
           from files where law_firm_id = $1 and id = any($2::uuid[])
         union all
         select ${JOINED_COLUMNS}, c.origin_id, c.up + 1
           from files f join chain c on f.id = c.parent_id
          where f.law_firm_id = $1
       )
       select ${COLUMNS}, origin_id from chain where up > 0 order by origin_id, up desc`,
      [lawFirmId, ids]);
    for (const r of rows) chains.get(r.origin_id)?.push(toEntity(r) as FileEntity);
    return chains;
  }

  /**
   * Insert a folder. A duplicate name is refused rather than numbered.
   *
   * Two files of one name are two documents. Two folders of one name is a typo,
   * and quietly creating "Contracts (1)" hides it: the firm then has two folders
   * that look the same in a picker and files scattered between them.
   */
  async createFolder(
    lawFirmId: string,
    // `taskId` tags a folder for a matter-linked task's view, the same way it
    // tags a file; see createFile. Left undefined, the parent's tag carries down.
    { parentId, name, createdBy, folderColor = null, taskId }: any,
    executor?: any,
  ) {
    assertNameLength(name);
    const parent = await this._requireFolder(lawFirmId, parentId, executor);
    try {
      const rows = await run(executor,
        `insert into files (law_firm_id, kind, name, parent_id, scope, matter_id, task_id, client_id, uploaded_by, folder_color)
         values ($1, 'folder', $2, $3, $4, $5, $6, $7, $8, $9)
         returning ${COLUMNS}`,
        [lawFirmId, name, parentId, parent.scope, parent.matterId,
          taskId === undefined ? parent.taskId : taskId,
          parent.clientId, createdBy, folderColor]);
      return toEntity(rows[0]);
    } catch (err: any) {
      if (nameTaken(err)) throw nameTakenError(name);
      throw err;
    }
  }

  /**
   * The one folder of this name under a parent, creating it on first use.
   *
   * For the folders the product owns rather than the firm: `note-attachments`
   * is the one that exists today. Several uploads can race to be the first
   * attachment on a matter, so this inserts and ignores the conflict rather than
   * checking first, the same way `ensureScopeRoot` does. A check-then-insert
   * hands the loser a duplicate-name error for a folder it did not ask to
   * create.
   */
  async ensureFolder(lawFirmId: string, parentId: any, name: string, executor?: any) {
    const existing = await run(executor,
      `select ${COLUMNS} from files
        where law_firm_id = $1 and parent_id = $2 and lower(name) = lower($3)
          and kind = 'folder' and deleted_at is null`,
      [lawFirmId, parentId, name]);
    if (existing[0]) return toEntity(existing[0]);

    try {
      return await this.createFolder(lawFirmId, { parentId, name, createdBy: null }, executor);
    } catch (err: any) {
      if (err?.code !== 'NAME_TAKEN' && !nameTaken(err)) throw err;
      const rows = await run(executor,
        `select ${COLUMNS} from files
          where law_firm_id = $1 and parent_id = $2 and lower(name) = lower($3)
            and kind = 'folder' and deleted_at is null`,
        [lawFirmId, parentId, name]);
      if (!rows[0]) throw err;
      return toEntity(rows[0]);
    }
  }

  /**
   * Insert a file row and assign its object path in the same statement.
   *
   * The path is derived from the row's own id, so it is decided by the database
   * and can never be guessed by two callers at once. The row exists before any
   * bytes do: it claims the name, and `finalize` stamps it once the object
   * lands.
   *
   * A name already taken by a live sibling becomes "name (1)", "name (2)" and so
   * on. The retry is driven by the unique index rather than by a prior existence
   * check, which is what makes it correct under a race.
   */
  async createFile(
    lawFirmId: string,
    {
      parentId, name, mimeType = null, uploadedBy = null, sizeBytes = null,
      signedViaSession = null,
      // A matter-linked task's documents live in the MATTER's tree and are told
      // apart by this column, so it is set independently of the parent folder.
      taskId,
      clientVisible = false,
    }: any,
    executor?: any,
  ) {
    assertNameLength(name);
    const parent = await this._requireFolder(lawFirmId, parentId, executor);
    const { stem, ext } = splitName(String(name));

    for (let n = 0; n <= MAX_NAME_TRIES; n += 1) {
      const candidate = n === 0 ? String(name) : `${stem} (${n})${ext}`;
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential probe for the first free name
        const rows = await run(executor,
          `insert into files
             (id, law_firm_id, kind, name, parent_id, scope, matter_id, task_id, client_id,
              mime_type, size_bytes, uploaded_by, signed_via_session, client_visible, object_path)
           select v.id, $1, 'file', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                  'lawfirmids/' || $1 || '/objects/' || v.id
             from (select gen_random_uuid() as id) v
           returning ${COLUMNS}`,
          [lawFirmId, candidate, parentId, parent.scope, parent.matterId,
            taskId === undefined ? parent.taskId : taskId,
            parent.clientId, mimeType, sizeBytes, uploadedBy, signedViaSession, clientVisible]);
        return toEntity(rows[0]);
      } catch (err: any) {
        if (!nameTaken(err)) throw err;
        // An executor in a failed transaction cannot be reused, so a caller that
        // passed one gets the conflict rather than a silent retry on a dead
        // handle. Route callers create files outside their transaction for this
        // reason; see files.upload.routes.
        if (executor) throw nameTakenError(String(name));
      }
    }
    throw new AppError(`Too many files named "${name}" here.`, 409, 'NAME_TAKEN');
  }

  /** The folder a write is aimed at, or a 404. Also carries the scope down. */
  async _requireFolder(lawFirmId: string, folderId: any, executor?: any): Promise<FileEntity> {
    if (!isUuid(folderId)) throw new AppError('A destination folder is required', 400, 'BAD_REQUEST');
    const rows = await run(executor,
      `select ${COLUMNS} from files
        where law_firm_id = $1 and id = $2 and kind = 'folder' and deleted_at is null`,
      [lawFirmId, folderId]);
    if (!rows[0]) throw new NotFoundError('Folder');
    return toEntity(rows[0]) as FileEntity;
  }

  /**
   * Stamp a file as landed, with the size and type storage actually reports.
   *
   * Returns the row plus `previouslyCounted`: the bytes this row was ALREADY
   * charged for before this call, which is what a caller subtracts to charge
   * only the change. It is read under the row lock, in the same transaction as
   * the stamp, so two finalizes that overlap serialize here and the second sees
   * the first's size. A caller that read the row itself and then called this
   * saw an unfinalized row in both requests, and charged the document twice.
   */
  async finalize(lawFirmId: string, fileId: any, { sizeBytes, mimeType = null }: any, executor?: any) {
    if (!isUuid(fileId)) throw new NotFoundError('File');
    const apply = async (tx: any) => {
      const before = await run(tx,
        `select finalized_at, size_bytes from files
          where law_firm_id = $1 and id = $2 and deleted_at is null
          for update`,
        [lawFirmId, fileId]);
      if (!before[0]) throw new NotFoundError('File');
      const previouslyCounted = before[0].finalized_at ? Number(before[0].size_bytes || 0) : 0;

      const rows = await run(tx,
        `update files
            set finalized_at = now(),
                size_bytes = $3,
                mime_type = coalesce($4, mime_type)
          where law_firm_id = $1 and id = $2
          returning ${COLUMNS}`,
        [lawFirmId, fileId, sizeBytes, mimeType]);
      return { ...toEntity(rows[0]), previouslyCounted };
    };
    return executor ? apply(executor) : withDrizzleTransaction(apply);
  }

  async rename(lawFirmId: string, fileId: any, name: any, executor?: any) {
    if (!isUuid(fileId)) throw new NotFoundError('File');
    assertNameLength(name);
    try {
      const rows = await run(executor,
        `update files set name = $3 where law_firm_id = $1 and id = $2 and deleted_at is null
         returning ${COLUMNS}`,
        [lawFirmId, fileId, name]);
      if (!rows[0]) throw new NotFoundError('File');
      return toEntity(rows[0]);
    } catch (err: any) {
      if (nameTaken(err)) throw nameTakenError(String(name));
      throw err;
    }
  }

  /**
   * Re-parent a row. One statement, whatever the subtree holds.
   *
   * The guard is the reason this is not a bare UPDATE: moving a folder into its
   * own subtree detaches that subtree from the root entirely. Nothing lists it,
   * and every recursive read below it loops. The check runs in the same
   * statement as the write, so a concurrent move cannot slip between them.
   */
  async move(lawFirmId: string, fileId: any, newParentId: any, executor?: any) {
    if (!isUuid(fileId)) throw new NotFoundError('File');
    if (String(fileId) === String(newParentId)) {
      throw new AppError('A folder cannot be moved into itself.', 409, 'MOVE_INTO_SELF');
    }
    const parent = await this._requireFolder(lawFirmId, newParentId, executor);
    const row = await this.findById(lawFirmId, fileId);
    if (!row) throw new NotFoundError('File');
    // Every column that says whose tree this is. Comparing only the matter let a
    // client's document move into another client's tree, since both carry
    // `scope = 'client'` and no matter.
    if (row.scope !== parent.scope
      || String(row.matterId) !== String(parent.matterId)
      || String(row.clientId) !== String(parent.clientId)
      || (row.scope === 'task' && String(row.taskId) !== String(parent.taskId))) {
      throw new AppError('A file cannot be moved out of its matter, task or client.', 409, 'MOVE_ACROSS_SCOPE');
    }

    try {
      const rows = await run(executor,
        `${SUBTREE_CTE}
         update files set parent_id = $3::uuid
          where law_firm_id = $1 and id = $2 and deleted_at is null
            and not exists (select 1 from subtree where subtree.id = $3::uuid)
          returning ${COLUMNS}`,
        [lawFirmId, fileId, newParentId]);
      if (!rows[0]) throw new AppError('A folder cannot be moved into itself.', 409, 'MOVE_INTO_SELF');
      return toEntity(rows[0]);
    } catch (err: any) {
      if (nameTaken(err)) throw nameTakenError(row.name);
      throw err;
    }
  }

  async setColor(lawFirmId: string, folderId: any, folderColor: any, executor?: any) {
    const rows = await run(executor,
      `update files set folder_color = $3
        where law_firm_id = $1 and id = $2 and kind = 'folder' and deleted_at is null
        returning ${COLUMNS}`,
      [lawFirmId, folderId, folderColor || null]);
    if (!rows[0]) throw new NotFoundError('Folder');
    return toEntity(rows[0]);
  }

  /**
   * Share a file or folder into the client portal, optionally with named clients
   * only.
   *
   * `clientIds` null means every client on the scope; a list narrows it. The
   * narrowing used to live as a `visibleClientIds` key on the object's metadata,
   * where no SQL read could apply it, so the whole restriction was invisible to
   * anything but the bucket walk.
   */
  async setVisibility(lawFirmId: string, fileId: any, { visible, clientIds = null }: any, executor?: any) {
    const apply = async (tx: any) => {
      const rows = await run(tx,
        `update files set client_visible = $3
          where law_firm_id = $1 and id = $2 and deleted_at is null
          returning ${COLUMNS}`,
        [lawFirmId, fileId, !!visible]);
      if (!rows[0]) throw new NotFoundError('File');

      await run(tx, `delete from file_client_visibility where law_firm_id = $1 and file_id = $2`,
        [lawFirmId, fileId]);
      const ids = visible && Array.isArray(clientIds) ? clientIds.filter(isUuid) : [];
      if (ids.length > 0) {
        await run(tx,
          `insert into file_client_visibility (law_firm_id, file_id, client_id)
           select $1, $2, unnest($3::uuid[])`,
          [lawFirmId, fileId, ids]);
      }
      return toEntity(rows[0]);
    };
    return executor ? apply(executor) : withDrizzleTransaction(apply);
  }

  /**
   * The same share, applied to a SET of rows in a fixed number of statements.
   *
   * Three statements whatever the selection holds: flip the flag, drop the old
   * narrowing, insert the new one as a cross product of files and named clients.
   * Calling `setVisibility` in a loop instead would open one transaction per
   * file, and a two-hundred-file share would take a connection two hundred
   * times over from a pool every other request on the instance shares.
   *
   * Missing ids are not an error here, unlike the single-row form: the caller
   * has already decided which of the ids it asked for are reachable, and the
   * rows this returns are the ones that really changed.
   */
  async setVisibilityMany(
    lawFirmId: string,
    fileIds: any[],
    { visible, clientIds = null }: any,
    executor?: any,
  ) {
    const ids = [...new Set((fileIds || []).filter(isUuid))];
    if (!isUuid(lawFirmId) || ids.length === 0) return [];

    const apply = async (tx: any) => {
      const rows = await run(tx,
        `update files set client_visible = $3
          where law_firm_id = $1 and id = any($2::uuid[]) and deleted_at is null
          returning ${COLUMNS}`,
        [lawFirmId, ids, !!visible]);

      await run(tx,
        `delete from file_client_visibility where law_firm_id = $1 and file_id = any($2::uuid[])`,
        [lawFirmId, ids]);

      // Narrowed only against the rows the UPDATE actually touched, so a
      // deleted id cannot leave a visibility row pointing at nothing.
      const updatedIds = rows.map((r: any) => r.id);
      const recipients = visible && Array.isArray(clientIds) ? clientIds.filter(isUuid) : [];
      if (updatedIds.length > 0 && recipients.length > 0) {
        await run(tx,
          `insert into file_client_visibility (law_firm_id, file_id, client_id)
           select $1, f.id, c.id
             from unnest($2::uuid[]) as f(id)
             cross join unnest($3::uuid[]) as c(id)`,
          [lawFirmId, updatedIds, recipients]);
      }
      return rows.map(toEntity);
    };
    return executor ? apply(executor) : withDrizzleTransaction(apply);
  }

  /** The clients a share is narrowed to, or an empty list for "all of them". */
  async visibilityClientIds(lawFirmId: string, fileId: any) {
    if (!isUuid(lawFirmId) || !isUuid(fileId)) return [];
    const rows = await run(null,
      `select client_id from file_client_visibility where law_firm_id = $1 and file_id = $2`,
      [lawFirmId, fileId]);
    return rows.map((r: any) => r.client_id);
  }

  /**
   * The same answer for a set of files, as `fileId -> clientIds`, in one query.
   *
   * A batched share needs each file's PRE-WRITE audience to work out who is
   * newly gaining access, and asking per file would put back exactly the round
   * trips the batch removed. A file with no narrowing is absent from the map,
   * which is the same "every client on the scope" that an empty list means.
   */
  async visibilityClientIdsForMany(lawFirmId: string, fileIds: any[]): Promise<Map<string, string[]>> {
    const ids = [...new Set((fileIds || []).filter(isUuid))];
    const byFile = new Map<string, string[]>();
    if (!isUuid(lawFirmId) || ids.length === 0) return byFile;
    const rows = await run(null,
      `select file_id, client_id from file_client_visibility
        where law_firm_id = $1 and file_id = any($2::uuid[])`,
      [lawFirmId, ids]);
    for (const row of rows) {
      const existing = byFile.get(row.file_id);
      if (existing) existing.push(row.client_id);
      else byFile.set(row.file_id, [row.client_id]);
    }
    return byFile;
  }

  /**
   * May this client see this file?
   *
   * The nearest SHARED row wins, walking from the file up. An unshared row is
   * not a decision, so a document inside a shared folder is visible whatever
   * its own flag says; there is no "private inside a shared folder" state. A
   * share is then narrowed by `file_client_visibility` when that row named
   * specific clients.
   */
  async visibleToClient(lawFirmId: string, fileId: any, clientId: any) {
    if (!isUuid(lawFirmId) || !isUuid(fileId) || !isUuid(clientId)) return false;
    const rows = await run(null,
      `with recursive chain as (
         select id, parent_id, client_visible, 0 as up
           from files where law_firm_id = $1 and id = $2 and deleted_at is null
         union all
         select f.id, f.parent_id, f.client_visible, c.up + 1
           from files f join chain c on f.id = c.parent_id
          where f.law_firm_id = $1 and f.deleted_at is null
       ),
       decision as (
         -- The nearest share decision, self included. A row that is not shared
         -- is not a decision: only a share stops the walk, so an unshared file
         -- inside a shared folder is visible, which is the inheritance the
         -- portal has always had.
         select id from chain where client_visible = true order by up asc limit 1
       )
       select d.id,
              not exists (
                select 1 from file_client_visibility v
                 where v.law_firm_id = $1 and v.file_id = d.id
              ) as unrestricted,
              exists (
                select 1 from file_client_visibility v
                 where v.law_firm_id = $1 and v.file_id = d.id and v.client_id = $3
              ) as named
         from decision d`,
      [lawFirmId, fileId, clientId]);
    if (!rows[0]) return false;
    return rows[0].unrestricted === true || rows[0].named === true;
  }

  /**
   * Every row in a scope one client may see.
   *
   * The portal's listing. Effective visibility is carried down the tree as the
   * query descends, so a folder's share reaches everything inside it in one
   * pass rather than one ancestor walk per file.
   */
  async listVisibleForClient(lawFirmId: string, rootId: any, clientId: any) {
    if (!isUuid(lawFirmId) || !isUuid(rootId) || !isUuid(clientId)) return [];
    const rows = await run(null,
      `with recursive tree as (
         select ${COLUMNS}, false as inherited_share, null::uuid as share_source
           from files where law_firm_id = $1 and id = $2 and deleted_at is null
         union all
         select ${JOINED_COLUMNS},
                case when f.client_visible then true else t.inherited_share end,
                case when f.client_visible then f.id else t.share_source end
           from files f join tree t on f.parent_id = t.id
          where f.law_firm_id = $1 and f.deleted_at is null
       )
       select ${COLUMNS} from tree t
        where t.inherited_share = true
          and (t.kind = 'folder' or t.finalized_at is not null)
          and (
            not exists (select 1 from file_client_visibility v
                         where v.law_firm_id = $1 and v.file_id = t.share_source)
            or exists (select 1 from file_client_visibility v
                        where v.law_firm_id = $1 and v.file_id = t.share_source and v.client_id = $3)
          )
        order by t.kind = 'folder' desc, lower(t.name) asc`,
      [lawFirmId, rootId, clientId]);
    return rows.map(toEntity);
  }

  /**
   * Soft-delete a row and everything under it, in one statement.
   *
   * The rows and their objects survive a retention window, so a delete is
   * recoverable and a legal hold still has something to hold. The sweeper
   * destroys both afterwards. A firm stops being charged for the bytes at this
   * point, not at destruction: nobody should pay for their own trash.
   */
  async softDeleteSubtree(lawFirmId: string, fileId: any, deletedBy: any, executor?: any) {
    if (!isUuid(fileId)) throw new NotFoundError('File');
    const rows = await run(executor,
      `${SUBTREE_CTE}
       update files set deleted_at = now(), deleted_by = $3
        where law_firm_id = $1 and deleted_at is null
          and id in (select id from subtree)
        returning ${COLUMNS}`,
      [lawFirmId, fileId, deletedBy || null]);
    if (rows.length === 0) throw new NotFoundError('File');
    return rows.map(toEntity);
  }

  /** Put a soft-deleted subtree back. Fails if a live sibling took its name. */
  async restoreSubtree(lawFirmId: string, fileId: any, executor?: any) {
    try {
      const rows = await run(executor,
        `${SUBTREE_CTE}
         update files set deleted_at = null, deleted_by = null
          where law_firm_id = $1 and deleted_at is not null
            and id in (select id from subtree)
          returning ${COLUMNS}`,
        [lawFirmId, fileId]);
      return rows.map(toEntity);
    } catch (err: any) {
      if (nameTaken(err)) {
        throw new AppError(
          'Something with this name is here now, so it cannot be restored. Rename that first.',
          409, 'NAME_TAKEN',
        );
      }
      throw err;
    }
  }

  /** A firm's storage usage: finalized, undeleted files only. */
  async sumFinalizedBytes(lawFirmId: string) {
    const rows = await run(null,
      `select coalesce(sum(size_bytes), 0)::bigint as bytes, count(*)::int as count
         from files
        where law_firm_id = $1 and kind = 'file'
          and finalized_at is not null and deleted_at is null`,
      [lawFirmId]);
    return { bytes: Number(rows[0].bytes), count: Number(rows[0].count) };
  }

  /**
   * The sweeper's work queue: rows whose objects should be destroyed.
   *
   * Two populations, and they are different failures. A soft-deleted row past
   * its retention window is an ordinary delete finishing. A file row that never
   * finalized is an upload that was started and abandoned, and its object may
   * or may not exist.
   */
  async listSweepable({ retentionDays = 30, unfinalizedHours = 24, limit = 500 } = {}) {
    const rows = await run(null,
      `select ${COLUMNS} from files f
        where f.kind = 'file' and f.object_path is not null
          and (
            (f.deleted_at is not null and f.deleted_at < now() - ($1 || ' days')::interval)
            or (f.finalized_at is null and f.created_at < now() - ($2 || ' hours')::interval)
          )
          -- A live legal hold outranks the retention window, on the document
          -- itself or on the matter it belongs to. Destroying held evidence
          -- because a timer expired is the one failure here that cannot be
          -- undone, and the hold is released by a person, not by a clock.
          and not exists (
            select 1 from legal_holds h
             where h.law_firm_id = f.law_firm_id
               and h.released_at is null
               and (h.file_id = f.id or (h.matter_id is not null and h.matter_id = f.matter_id))
          )
        order by coalesce(f.deleted_at, f.created_at) asc
        limit $3`,
      [String(retentionDays), String(unfinalizedHours), limit]);
    return rows.map(toEntity);
  }

  /**
   * Destroy the deleted folders that have nothing left under them.
   *
   * A folder holds no bytes, so the sweep of documents never touches it, and a
   * row that is never collected is a row forever. One pass takes the deepest
   * level; the caller repeats until a pass takes nothing, which is what makes a
   * folder go only after everything beneath it has.
   *
   * A folder with anything still under it is kept, whatever its age: the thing
   * beneath may be a document a legal hold is protecting, and destroying its
   * folder would orphan it. A scope root is never a candidate, because it is
   * never soft-deleted and has no parent.
   */
  async hardDeleteEmptyDeletedFolders({ retentionDays = 30 } = {}) {
    const rows = await run(null,
      `delete from files f
        where f.kind = 'folder' and f.parent_id is not null
          and f.deleted_at is not null
          and f.deleted_at < now() - ($1 || ' days')::interval
          and not exists (select 1 from files c where c.parent_id = f.id)
        returning f.id`,
      [String(retentionDays)]);
    return rows.length;
  }

  /**
   * Remove the rows a cancelled upload claimed, so their names are free at once
   * instead of after the sweeper's 24 hours.
   *
   * Every condition is in the DELETE itself rather than checked beforehand, so a
   * finalize racing this cannot lose its document: the stamp takes the row lock,
   * and a row stamped first no longer matches `finalized_at is null`. Only the
   * caller's own claims go (`uploaded_by`), and a row under a live legal hold is
   * left for the sweeper, which honours holds the same way.
   *
   * Resolves to the deleted rows, whose objects the caller then removes.
   */
  async deleteUnfinalizedUploads(lawFirmId: string, fileIds: any[], uploadedBy: string) {
    const ids = [...new Set((fileIds || []).filter(isUuid))];
    if (!isUuid(lawFirmId) || ids.length === 0 || !uploadedBy) return [];
    const rows = await run(null,
      `delete from files f
        where f.law_firm_id = $1 and f.id = any($2::uuid[])
          and f.kind = 'file' and f.finalized_at is null and f.deleted_at is null
          and f.uploaded_by = $3
          and not exists (
            select 1 from legal_holds h
             where h.law_firm_id = f.law_firm_id
               and h.released_at is null
               and (h.file_id = f.id or (h.matter_id is not null and h.matter_id = f.matter_id))
          )
        returning ${JOINED_COLUMNS}`,
      [lawFirmId, ids, String(uploadedBy)]);
    return rows.map(toEntity);
  }

  /** Remove rows for good. Only the sweeper calls this. */
  async hardDelete(fileIds: string[], executor?: any) {
    const ids = (fileIds || []).filter(isUuid);
    if (ids.length === 0) return 0;
    const rows = await run(executor,
      `delete from files where id = any($1::uuid[]) returning id`, [ids]);
    return rows.length;
  }
}

export = Object.assign(new FilesRepository(), {
  splitName, SUBTREE_DEFAULT_PAGE_SIZE, SUBTREE_MAX_PAGE_SIZE,
});
