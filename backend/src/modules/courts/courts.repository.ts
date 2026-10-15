import { createLookupRepository } from '../../shared/lookup/lookupRepository';
import { courts } from '../../shared/database/drizzle/schema';

export = createLookupRepository(courts);
