import { asc } from 'drizzle-orm';
import { DrizzleRepository } from '../../shared/database/DrizzleRepository';
import { noteTemplates } from '../../shared/database/drizzle/schema';
import { tenantQuery } from '../../shared/database/queryContext';

class NoteTemplatesRepository extends DrizzleRepository {
  constructor() {
    super(noteTemplates as any);
  }

  /** List a firm's custom note templates, ordered by label. */
  async listOrdered(lawFirmId: string) {
    const rows = await tenantQuery(
      noteTemplates,
      lawFirmId,
      ({ executor, scope }) => executor
        .select()
        .from(noteTemplates)
        .where(scope)
        .orderBy(asc(noteTemplates.label)),
    );
    return rows.map((row) => this.toEntity(row));
  }
}

export = new NoteTemplatesRepository();
