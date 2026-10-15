// How a fill route tells the browser which placeholders it left blank.
//
// The fill endpoints stream binary (a .docx or .pdf), so there is no JSON body
// to carry the report: it rides on a response header instead. Tag names come
// from a Word document and can hold any Unicode ("{Nombre del cliente}"), while
// header values are latin-1, so the payload is percent-encoded JSON.
//
// Pure module: shared by the Route Handlers and the client-side service shim so
// the two agree on the wire format.

export const UNFILLED_FIELDS_HEADER = 'X-Unfilled-Fields'

/** Encode a report for the header. An empty list encodes as an empty value. */
export function encodeUnfilledFields(fields: readonly string[]): string {
  if (fields.length === 0) return ''
  return encodeURIComponent(JSON.stringify(fields))
}

/**
 * Decode a header value back into the field list. A missing, empty or malformed
 * value yields []: a fill that succeeded must never fail on its own diagnostic.
 */
export function decodeUnfilledFields(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string')
  } catch {
    return []
  }
}
