import { createLookupRepository } from '../../shared/lookup/lookupRepository';
import { practiceAreas } from '../../shared/database/drizzle/schema';

export = createLookupRepository(practiceAreas);
