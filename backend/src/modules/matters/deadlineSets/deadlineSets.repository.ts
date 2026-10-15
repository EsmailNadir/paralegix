import { deadlineSetTemplates } from '../../../shared/database/drizzle/schema';
import { DrizzleRepository } from '../../../shared/database/DrizzleRepository';

/**
 * Deadline set templates: a named list of offsets a firm applies to a matter.
 *
 * Plain tenant-scoped CRUD, which is what `DrizzleRepository` is for. It was a
 * `SqlRepository` constructed with the table NAME and `{ jsonb: ['items'] }`;
 * Drizzle knows the column is jsonb from the schema, so the option has nothing
 * left to declare.
 */
class DeadlineSetsRepository extends DrizzleRepository {
  constructor() {
    super(deadlineSetTemplates as any);
  }
}

export = new DeadlineSetsRepository();
