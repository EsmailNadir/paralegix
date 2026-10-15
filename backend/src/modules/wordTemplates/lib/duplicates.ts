// Same-name handling for uploaded templates. The template list is flat, so a
// name is how staff tell templates apart: an upload whose name is already
// taken offers Replace / Save as a copy instead of silently adding a second
// template with that name. Whether a name is taken is the repository's
// question (firm-scoped, case-insensitive, per type); this module only
// chooses the copy name.

import { randomUUID } from 'crypto'

// "Name (copy)", "Name (copy 2)", ...: the first that `isTaken` does not
// report. The caller passes a check scoped to the template's own type, so a
// PDF-form copy is checked against PDF forms, not Word templates.
export async function uniqueCopyName(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  for (let n = 1; n < 100; n += 1) {
    const candidate = (n === 1 ? `${base} (copy)` : `${base} (copy ${n})`).slice(0, 200)
    if (!(await isTaken(candidate))) return candidate
  }
  return `${base} (${randomUUID().slice(0, 8)})`.slice(0, 200)
}
