// Naming a value-shaped detection from the words written just before it, and
// for an amount, from one cue just after it ("$300.00 per hour").
//
// WHY this exists:
//   The shape pass (./detect-patterns) knows a span is an amount or a date but
//   not WHICH one, so it names them amount_1, date_2. Those names never
//   auto-fill: the fill engine resolves a tag through the canonical vocabulary,
//   and amount_1 is not in it. On an uploaded representation agreement every fee
//   term came out generic and nothing filled. Yet the prose usually says what
//   the value is ("an initial payment of $2,500.00"), and when those words are a
//   vocabulary name the value can carry that name instead.
//
// WHY it is this conservative:
//   A wrong canonical name is worse than a generic one. amount_1 makes the
//   paralegal type the value; flat_fee_amount on the wrong amount prints the
//   case's flat fee into a clause about something else, in a legal document,
//   and nothing on screen says it happened. So a name comes back only when all
//   of these hold, and null (keep the generic name) otherwise:
//     - the words sit in the same paragraph and the same clause as the value;
//     - the phrase starts at the start of that clause or right after a function
//       word, so a qualifier is never dropped: "a flat rate of" must not be read
//       as "rate", nor "the client's office phone" as "office phone";
//     - the phrase has a word that says WHICH value or WHOSE. A bare "Phone:" or
//       "Fee:" names a kind of value; the vocabulary resolves it to one party's
//       field only because hand-authored tags needed a default;
//     - the id it resolves to is on this shape's allow-list below.
//
// Pure module: no I/O, no docx, no React.

import { normalizeFieldKey, resolveCanonicalId } from '../vocabulary'

/** The value shapes ./detect-patterns names generically. */
export type ContextShape = 'money' | 'date' | 'time' | 'email' | 'phone' | 'zip'

// The ids each shape may be named after. The vocabulary carries no value type
// per entry, so this list IS the type check: a date is never named after a
// money field, however its label reads. Deliberately narrow:
//   - money and date: the fee terms a representation agreement states. Left out
//     are the ledger figures (outstanding_balance, total_paid_amount, ...),
//     because the same words in a contract ("the remaining balance of $2,000")
//     state a contract term and the fill would print today's ledger figure in
//     its place; the schedule-row columns (payment_amount, payment_date, ...),
//     which only mean something inside a {#payments} loop; and the hearing,
//     trial and deadline dates, which fill with the case's NEXT setting while a
//     precedent's prose is as likely to describe a past one.
//   - time: nothing, for the same reason as the hearing date.
const ALLOWED: Record<ContextShape, ReadonlySet<string>> = {
  money: new Set([
    'flat_fee_amount',
    'hourly_rate',
    'initial_payment_amount',
    'installment_amount',
    'next_payment_amount',
    'retainer_amount',
    'down_payment_amount',
  ]),
  date: new Set(['initial_payment_date', 'final_payment_date', 'next_payment_due_date']),
  time: new Set(),
  email: new Set(['client_email', 'firm_email', 'attorney_email', 'service_recipient_email']),
  phone: new Set(['client_phone', 'firm_phone', 'firm_fax']),
  zip: new Set(['firm_zip']),
}

// Prose names a value by what it is FOR ("an initial payment of $500") and the
// vocabulary by what it is plus its kind (initial_payment_amount). The phrase
// with the kind word appended is tried FIRST: it is the more specific name, and
// a bare phrase may itself be an alias of a sibling field ("initial payment"
// is the amount), which would otherwise shadow the date. Nothing is removed.
const KIND_WORD: Partial<Record<ContextShape, string>> = { money: 'amount', date: 'date' }

// Function words. Stripped from the end of the label ("in the amount of", "is
// due on"), and the only words a phrase may start right after.
//
// Possessive pronouns (your, our, their) are deliberately absent: they say
// WHOSE value it is, and dropping one is exactly how "your office phone"
// would become the firm's phone.
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'with', 'by', 'at', 'on', 'in',
  'is', 'are', 'was', 'were', 'be', 'been', 'will', 'shall', 'each', 'this', 'that',
  'such', 'any', 'as', 'plus', 'then', 'from', 'upon', 'due', 'payable', 'amount',
  'before', 'no', 'later', 'than',
])

// Words that name a KIND of value without saying which one or whose. A phrase
// made only of these and function words ("Phone Number:", "Fee:", "Amount
// due:") never names.
const GENERIC_WORDS = new Set([
  'amount', 'sum', 'total', 'fee', 'fees', 'rate', 'price', 'cost', 'payment',
  'payments', 'balance', 'due', 'date', 'day', 'time', 'phone', 'telephone', 'tel',
  'mobile', 'cell', 'number', 'no', 'fax', 'email', 'e', 'mail', 'address', 'zip',
  'code', 'postal',
])

// Longest label read. Longer runs are a sentence, not a label.
const MAX_PHRASE_WORDS = 5

// A token that is itself a value (a figure, an address, a placeholder). Words
// before another value describe THAT value, so the label stops here.
const VALUE_TOKEN = /[\d@$[\]{}]/
// Money, for the one place a label may reach back across a value: a payment's
// date follows its amount ("an initial payment of $500.00 due on March 1").
const MONEY_TOKEN = /^\$\d/
// A token ending a clause. Checked on every word of the label, including the
// one touching the value ("is due. March 1"); the label's own trailing colon is
// removed before tokenising, so it never counts.
const CLAUSE_END = /[.,;:!?)]$/

// An amount billed by the hour says so right after itself; the firm's own
// agreement has no label before its "$300.00 per hour" at all. Nothing but
// spaces may sit between the amount and the cue, so the cue is always in the
// amount's clause and paragraph ([ \t], never \s, which matches a line break),
// and any other period ("per month") is not read.
const HOURLY_CUE = /^[ \t]*(?:per[ \t]+hour|an[ \t]+hour|\/[ \t]*(?:hr|hour)|hourly)\b/i

const bare = (token: string) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toLowerCase()
const isStop = (token: string) => STOP_WORDS.has(bare(token))

/**
 * The canonical vocabulary id the words around a detected value name, or null
 * when they do not name one confidently enough to auto-fill.
 *
 * `before` is the text preceding the value, `after` the text following it.
 * Only the value's own paragraph is read: a line break ends either side,
 * however the caller sliced the text.
 */
export function nameFromContext(before: string, shape: ContextShape, after = ''): string | null {
  const allowed = ALLOWED[shape]
  if (allowed.size === 0) return null

  const byLabel = nameFromLabel(before, shape, allowed)
  // Only a money shape's allow-list holds hourly_rate, so only an amount can
  // take its name from the cue.
  const byCue = nameFromCue(after, allowed)
  // "a flat fee of $300 per hour" contradicts itself; neither name is safe.
  if (byLabel && byCue && byLabel !== byCue) return null
  return byLabel ?? byCue
}

function nameFromCue(after: string, allowed: ReadonlySet<string>): string | null {
  if (!HOURLY_CUE.test(after)) return null
  const id = resolveCanonicalId('hourly_rate')
  return id && allowed.has(id) ? id : null
}

function nameFromLabel(before: string, shape: ContextShape, allowed: ReadonlySet<string>): string | null {
  // Same paragraph only. documentText() joins paragraphs with "\n", and a label
  // pattern that let whitespace span it once walked into the next paragraph.
  const paragraph = before.slice(Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r')) + 1)

  // "Phone: ", "Flat fee - ": the label's own punctuation, not a clause end.
  const tokens = paragraph.replace(/[\s:=-]+$/, '').split(/\s+/).filter(Boolean)

  let words = clauseBefore(tokens, tokens.length)
  if (shape === 'date' && words.length === 0) {
    const at = tokens.length - clauseLength(tokens, tokens.length) - 1
    if (at >= 0 && MONEY_TOKEN.test(tokens[at]) && !CLAUSE_END.test(tokens[at])) {
      words = clauseBefore(tokens, at)
    }
  }
  return resolvePhrase(words, shape, allowed)
}

/** How many tokens before `end` belong to the same clause. */
function clauseLength(tokens: readonly string[], end: number): number {
  let start = end
  while (start > 0) {
    const t = tokens[start - 1]
    if (VALUE_TOKEN.test(t) || CLAUSE_END.test(t)) break
    start -= 1
  }
  return end - start
}

/** The words of the clause ending at `end`, with trailing function words removed. */
function clauseBefore(tokens: readonly string[], end: number): string[] {
  const words = tokens.slice(end - clauseLength(tokens, end), end).map(bare).filter(Boolean)
  while (words.length > 0 && isStop(words[words.length - 1])) words.pop()
  return words
}

function resolvePhrase(
  words: readonly string[],
  shape: ContextShape,
  allowed: ReadonlySet<string>,
): string | null {
  const kind = KIND_WORD[shape]
  // Longest first, so "initial payment" is read before "payment".
  for (let i = Math.max(0, words.length - MAX_PHRASE_WORDS); i < words.length; i++) {
    if (isStop(words[i])) continue
    if (i > 0 && !isStop(words[i - 1])) continue
    const phrase = words.slice(i).join(' ')
    const parts = normalizeFieldKey(phrase).split('_')
    if (parts.every((p) => GENERIC_WORDS.has(p) || STOP_WORDS.has(p))) continue

    for (const candidate of kind ? [`${phrase} ${kind}`, phrase] : [phrase]) {
      const id = resolveCanonicalId(candidate)
      if (!id) continue
      // The words name a field, and it is not one this shape can fill ("Flat
      // fee: March 1, 2026"). A shorter phrase would only name something else.
      return allowed.has(id) ? id : null
    }
  }
  return null
}
