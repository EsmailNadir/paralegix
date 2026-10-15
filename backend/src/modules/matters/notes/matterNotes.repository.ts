/**
 * Matter notes CRUD.
 *
 * A thin instantiation of the shared notes repository (`shared/notes/`),
 * which matter, task, and client notes all use identically — the three
 * tables share the same shape as of migration 0149. Kept as its own module
 * (rather than inlined into `notes.service.ts`) because
 * `noteLinks.service.ts` still reads a note's raw row directly for its
 * own matter-only linking feature.
 */

import { notes } from '../../../shared/database/drizzle/schema';
import { createNotesRepository, formatNote } from '../../../shared/notes/notesRepository';

const repo = createNotesRepository({ parentColumn: 'matterId' });

export = Object.assign(repo, { formatNote });
