/**
 * Signing fixtures: a session with its participants, public tokens, access-code
 * challenges and fields, seeded in one call, plus the small pieces the signing
 * specs share (a real PNG, a blank PDF, a digest, a completion body).
 *
 * Plain SQL through the test pool, like every other factory. Each insert is
 * asserted to have landed: a seed that silently wrote nothing would send every
 * case that uses it to a 404 and let it pass for the wrong reason.
 *
 * Only the columns every signing row needs are defaulted. A spec whose case
 * depends on a session column (routing mode, the signer pointer, a sealed hash,
 * an expiry) passes it through `session`, so what the case is about stays
 * visible at the call site.
 */
import { createHash, randomBytes, randomUUID } from 'crypto';
import { testPool } from './db';
import {
  pointFirmSourceAt, seedSessionSourceSql, sessionKeysSql,
} from './factories';
import { objects, putObject } from './inMemoryBucket';

export interface SigningFieldSeed {
  fieldType?: 'signature' | 'initials' | 'text' | 'date' | 'checkbox';
  label?: string;
  required?: boolean;
  page?: number;
  xPercent?: number;
  yPercent?: number;
  widthPercent?: number;
  heightPercent?: number;
  /** Defaults to the field's position within its participant. */
  sortOrder?: number;
}

export interface SigningChallengeSeed {
  secretHash?: string | null;
  attempts?: number;
  lifetimeAttempts?: number;
  lockedUntil?: string | null;
  verifiedAt?: string | null;
}

export interface SigningParticipantSeed {
  /** Defaults to `part-<suffix>-<index>`. */
  id?: string;
  /** Defaults to `Signer <order>`. */
  name?: string;
  /** Defaults to the name squashed into `<name>@example.test`; `null` stores none. */
  email?: string | null;
  /** Defaults to `Signer <order>`; `null` stores none. */
  roleLabel?: string | null;
  /** Defaults to the participant's position, from 1. */
  order?: number;
  /** Defaults to `active`. */
  status?: string;
  deliveryMethod?: string;
  /** Any other participant column, keyed by its SQL name. */
  columns?: Record<string, unknown>;
  /** Seed no public token row. The session token is then the only handle. */
  token?: false;
  /** Defaults to `pub-<suffix>-<index>`. */
  publicToken?: string;
  consumed?: boolean;
  /** An `access_code` challenge row. A participant with no code has none. */
  challenge?: SigningChallengeSeed;
  fields?: SigningFieldSeed[];
}

export interface SigningSessionSeed {
  lawFirmId: string;
  createdBy: string | null;
  /** Defaults to `sess-<suffix>`. */
  token?: string;
  /** Defaults to the firm's seeded source. */
  sourceId?: string;
  /**
   * Session columns keyed by SQL name, laid over the defaults: `pending`,
   * `Engagement Agreement.pdf`, and an expiry a week out.
   */
  session?: Record<string, unknown>;
  participants?: SigningParticipantSeed[];
}

export interface SeededSigningParticipant {
  participantId: string;
  /** Empty when the participant was seeded with `token: false`. */
  publicToken: string;
  name: string;
  order: number;
  fieldIds: string[];
}

export interface SeededSigningSession {
  sessionToken: string;
  suffix: string;
  participants: SeededSigningParticipant[];
}

/** An insert built from a column map, with some values as raw SQL expressions. */
async function insertRow(
  table: string,
  values: Record<string, unknown>,
  raw: Record<string, (param: (value: unknown) => string) => string> = {},
): Promise<number> {
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const columns: string[] = [];
  const placeholders: string[] = [];
  for (const [column, build] of Object.entries(raw)) {
    columns.push(column);
    placeholders.push(build(param));
  }
  for (const [column, value] of Object.entries(values)) {
    columns.push(column);
    placeholders.push(param(value));
  }
  const { rowCount } = await testPool.query(
    `insert into ${table} (${columns.join(', ')}) values (${placeholders.join(', ')})`,
    params,
  );
  return rowCount ?? 0;
}

const emailFor = (name: string) => `${name.toLowerCase().replace(/\W+/g, '')}@example.test`;

export async function seedSigningSession(options: SigningSessionSeed): Promise<SeededSigningSession> {
  const suffix = randomBytes(8).toString('hex');
  const sessionToken = options.token ?? `sess-${suffix}`;

  const sessionRows = await insertRow(
    'signature_sessions',
    {
      token: sessionToken,
      law_firm_id: options.lawFirmId,
      created_by: options.createdBy,
      status: 'pending',
      file_name: 'Engagement Agreement.pdf',
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      ...(options.sourceId ? { source_id: options.sourceId } : {}),
      ...options.session,
    },
    options.sourceId ? {} : { source_id: (param) => seedSessionSourceSql(param(options.lawFirmId)) },
  );
  if (sessionRows !== 1) throw new Error(`seedSigningSession: session ${sessionToken} was not inserted`);

  const participants: SeededSigningParticipant[] = [];
  for (const [index, input] of (options.participants ?? []).entries()) {
    // eslint-disable-next-line no-await-in-loop
    participants.push(await seedSigningParticipant(
      { sessionToken },
      input,
      { index, idSuffix: `${suffix}-${index}` },
    ));
  }

  return { sessionToken, suffix, participants };
}

/**
 * One participant on a session that already exists, with its public token and
 * any challenge or fields it names. `seedSigningSession` calls this for each
 * participant it is given; a spec calls it directly to add one later.
 */
export async function seedSigningParticipant(
  session: { sessionToken: string },
  input: SigningParticipantSeed = {},
  position: { index: number; idSuffix: string } = { index: 0, idSuffix: randomBytes(8).toString('hex') },
): Promise<SeededSigningParticipant> {
  const { sessionToken } = session;
  const { idSuffix } = position;
  const order = input.order ?? position.index + 1;
  const name = input.name ?? `Signer ${order}`;
  const participantId = input.id ?? `part-${idSuffix}`;

  const participantRows = await insertRow(
    'signature_participants',
    {
      id: participantId,
      role_label: input.roleLabel === undefined ? `Signer ${order}` : input.roleLabel,
      name,
      email: input.email === undefined ? emailFor(name) : input.email,
      signing_order: order,
      status: input.status ?? 'active',
      delivery_method: input.deliveryMethod ?? 'email',
      ...input.columns,
    },
    { 'session_id, law_firm_id': (param) => sessionKeysSql(param(sessionToken)) },
  );
  if (participantRows !== 1) throw new Error(`seedSigningParticipant: ${participantId} was not inserted`);

  if (input.challenge) {
    const challenge = input.challenge;
    const { rowCount } = await testPool.query(
      `insert into signature_challenges
         (law_firm_id, session_id, participant_id, kind, secret_hash,
          attempts, lifetime_attempts, locked_until, verified_at)
       select p.law_firm_id, p.session_id, p.id, 'access_code', $2, $3, $4, $5, $6
         from signature_participants p where p.id = $1`,
      [participantId, challenge.secretHash ?? null, challenge.attempts ?? 0,
        challenge.lifetimeAttempts ?? 0, challenge.lockedUntil ?? null, challenge.verifiedAt ?? null],
    );
    if (rowCount !== 1) throw new Error(`seedSigningParticipant: challenge for ${participantId} was not inserted`);
  }

  let publicToken = '';
  if (input.token !== false) {
    publicToken = input.publicToken ?? `pub-${idSuffix}`;
    const tokenRows = await insertRow(
      'signature_participant_tokens',
      {
        token: publicToken,
        participant_id: participantId,
        delivery_method: input.deliveryMethod ?? 'email',
        consumed_at: input.consumed ? new Date().toISOString() : null,
      },
      { 'session_id, law_firm_id': (param) => sessionKeysSql(param(sessionToken)) },
    );
    if (tokenRows !== 1) throw new Error(`seedSigningParticipant: token for ${participantId} was not inserted`);
  }

  const fieldIds: string[] = [];
  for (const [fieldIndex, field] of (input.fields ?? []).entries()) {
    const fieldId = `fld-${idSuffix}-${fieldIndex}`;
    // eslint-disable-next-line no-await-in-loop
    const fieldRows = await insertRow(
      'signature_fields',
      {
        id: fieldId,
        signer_id: participantId,
        page: field.page ?? 1,
        x_percent: field.xPercent ?? 20,
        y_percent: field.yPercent ?? 10 + fieldIndex * 5,
        width_percent: field.widthPercent ?? 20,
        height_percent: field.heightPercent ?? 6,
        field_type: field.fieldType ?? 'signature',
        label: field.label ?? `Field ${fieldIndex + 1}`,
        required: field.required ?? true,
        sort_order: field.sortOrder ?? fieldIndex,
      },
      { 'session_id, law_firm_id': (param) => sessionKeysSql(param(sessionToken)) },
    );
    if (fieldRows !== 1) throw new Error(`seedSigningParticipant: field ${fieldId} was not inserted`);
    fieldIds.push(fieldId);
  }

  return { participantId, publicToken, name, order, fieldIds };
}

/**
 * Store `bytes` as a source PDF and point the firm's seeded source at them.
 *
 * Finalization opens the prepared object pinned to the generation the source
 * row records, so a spec that finalizes needs the row to describe the bytes it
 * actually stored. Returns the object path, which a session's `object_path`
 * names.
 */
export async function storeSigningSource(lawFirmId: string, bytes: Buffer): Promise<string> {
  const objectPath = `signing-uploads/${lawFirmId}/${randomBytes(8).toString('hex')}/agreement.pdf`;
  putObject(objectPath, { body: bytes, contentType: 'application/pdf' });
  const stored = objects.get(objectPath)!;
  await pointFirmSourceAt(lawFirmId, objectPath, stored.generation, stored.bytes);
  return objectPath;
}

/** A real 1x1 PNG. Small, valid, and embeddable by pdf-lib. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** `TINY_PNG` as the data URL a signature or initials field carries. */
export const SIGNATURE_DATA_URL = `data:image/png;base64,${TINY_PNG.toString('base64')}`;

export const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

/** A blank US Letter PDF with `pageCount` pages, written by pdf-lib. */
export async function makePdf(pageCount = 1): Promise<Buffer> {
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

/**
 * The body the signing page posts to `/complete`: consent, a fresh idempotency
 * key, and whatever the case adds (the revision it read, its field values).
 */
export function completionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    consentAgreed: true,
    consentName: 'Signer One',
    consentTimestamp: new Date().toISOString(),
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

/**
 * Occupy every heavy-transfer slot until `release()`.
 *
 * Required lazily so a spec can set `TRANSFER_SLOT_TIMEOUT_MS` before the slot
 * module reads it.
 */
export function holdEverySlot(): { ready: Promise<unknown>; release: () => Promise<void> } {
  const { withPdfSlot } = require('../../src/modules/signatures/signingJobs');
  const { SLOT_CONCURRENCY } = require('../../src/shared/utils/transferSlot');
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started: Promise<void>[] = [];
  const running = Array.from({ length: SLOT_CONCURRENCY }, () => {
    let signalStarted: () => void = () => {};
    started.push(new Promise<void>((resolve) => { signalStarted = resolve; }));
    return withPdfSlot(async () => {
      signalStarted();
      await held;
    });
  });
  return {
    ready: Promise.all(started),
    release: async () => {
      release();
      await Promise.all(running);
    },
  };
}

/**
 * Await what a completion leaves running after it has answered.
 *
 * The signer's response is written before the completion emails are sent and
 * before any background drain it started has finished, so a spec asserting on
 * either has to wait for them. Both are registered as background writes, which
 * is also what keeps them from straggling into the next spec's truncate.
 */
export async function settleAfterResponse(): Promise<void> {
  const { drainBackgroundWrites } = require('../../src/shared/utils/backgroundWrites');
  await drainBackgroundWrites();
}
