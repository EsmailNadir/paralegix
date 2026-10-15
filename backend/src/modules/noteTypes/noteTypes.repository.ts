import { asc } from 'drizzle-orm';
import { DrizzleRepository } from '../../shared/database/DrizzleRepository';
import { noteTypes } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';
import { scopedUpsert } from '../../shared/database/scopedWrite';

class NoteTypesRepository extends DrizzleRepository {
  constructor() {
    super(noteTypes as any);
  }

  /** List a firm's custom note types, ordered by label. */
  async listOrdered(lawFirmId: string) {
    const rows = await tenantQuery(
      noteTypes,
      lawFirmId,
      ({ executor, scope }) => executor
        .select()
        .from(noteTypes)
        .where(scope)
        .orderBy(asc(noteTypes.label)),
    );
    return rows.map((row) => this.toEntity(row));
  }

  /** Every value already in use for a firm (for slug-collision avoidance). */
  async listValues(lawFirmId: string): Promise<string[]> {
    const rows = await this.listOrdered(lawFirmId);
    return rows.map((row: any) => row.value);
  }

  /**
   * Set the color shown for `value`. Upserts on (law_firm_id, value) so this
   * also creates the row the first time a firm colors a built-in type, which
   * otherwise has no row of its own.
   */
  async setColor(lawFirmId: string, value: string, label: string, color: string) {
    // Passed as a literal rather than through `toValues`, whose
    // `Record<string, unknown>` return would erase the column check that
    // `scopedUpsert` performs against the table. This repository declares no
    // column aliases, so `toValues` would only have dropped undefined values,
    // and none of these three can be undefined.
    const rows = await scopedUpsert(
      noteTypes,
      lawFirmId,
      { value, label, color },
      [noteTypes.lawFirmId, noteTypes.value],
      { color },
    );
    return this.toEntity(rows[0] as Record<string, unknown>);
  }
}

export = new NoteTypesRepository();
