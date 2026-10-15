---
paths:
  - "backend/src/modules/signatures/pdf/**"
  - "backend/src/modules/signatures/signing*.ts"
  - "backend/tests/signatures/pdf/**"
---

# The incremental PDF signing engine

One rule explains every design decision here: **a PDF is a range of bytes in storage, never an
object in this process.** A 2 GB document cannot be a Buffer on a 512 MiB instance, so nothing
below holds one. If a change you are making would put a whole document in memory, it is the wrong
change however reasonable it looks.

The old path ran five whole-document passes through pdf-lib and peaked at 299 MB for a 20 MB
document, which is why the cap was once 20 MB. The streaming path lifted `SIGNING_MAX_FILE_BYTES`
to 500 MB (`signing.validation.ts`). The cap still describes the implementation, not anything a
law firm would recognise.

## What is where

| File | Owns |
|---|---|
| `types.ts` | The contract. `StoredPdf`, `PdfSource`, `PdfValue`. No whole-file read exists. |
| `gcsSource.ts` | Bounded reads, capped by the SOURCE not the caller. Every read pins a generation. |
| `lexer.ts` | Tokens, with a nesting depth and a container-entry ceiling. |
| `filters.ts` | Decoding, bounded DURING inflation rather than after it. |
| `reader.ts` | Cross-reference chains, object streams, hybrid `/XRefStm`. No recovery scan. |
| `pages.ts` | The page tree, inherited geometry, rotation, `/UserUnit`. |
| `writer.ts` | Incremental updates, absolute offsets, the fixed-width signature area. |
| `compose.ts` | Server-side joins, pairwise, generations pinned. |
| `digest.ts`, `resumableDigest.ts` | Streamed and resumable SHA-256. |
| `cms.ts`, `seal.ts`, `verifySeal.ts` | The signature, and checking it. |
| `appearances.ts`, `fieldPlacement.ts`, `fieldAppearance.ts` | Where a mark goes and how it draws. |
| `appendPage.ts`, `certificateContent.ts` | The certificate pages. |
| `forms.ts` | Flattening, before the signer sees the document. |

Above them: `signingSources.ts` (admission), `signingJobs.ts` (durable work),
`signingPipeline.ts` (the two artifacts), `signingFinalize.ts` (a session's artifacts),
`signingAudit.ts` (re-reading one sampled artifact).

## Rules that are not preferences

**Offsets are absolute**, measured from the start of the composed file. Getting this wrong
produces a document that opens in a forgiving viewer and fails verification, which is the worst
outcome available: it looks signed.

**Refuse rather than default.** A missing `/MediaBox` is an error, never US Letter. A placement
that does not fit is refused, never clamped. A form appearance that cannot be proved is refused,
never guessed. Each of those defaults puts a mark somewhere the signer did not put it.

**`/ByteRange` and `/Contents` keep a fixed byte width** from the first layout. Patching a field
that changes width moves every byte after it, and the signature then describes a file that does
not exist. The writer emits both and reports their offsets; do not write them as ordinary values.

**Seal order is load-bearing.** ByteRange is written before anything is hashed. Delivery is sealed
before the certificate, because the certificate states the delivered copy's hash. The certificate
is appended to the UNSEALED stamped source, never to a sealed copy.

**A saved hash state is dangerous.** Resumed over the wrong bytes it produces a digest of a
sequence that was never in any file, and that digest signs cleanly. The recorded path, generation
and byte length are checked before the load, and a mismatch is `SOURCE_CHANGED`, which is not
recoverable by re-hashing.

**A generation is a string.** Coerced to a JS number a GCS generation rounds past 2^53, so two
versions compare equal.

## Testing this

Everything inside this engine agrees with itself by construction, so the checks that matter come
from outside it: Node's own SHA-256 over the composed bytes, the OpenSSL binary over the covered
range, and pdf-lib parsing the result. Then change one covered byte and require all of it to fail.

A test that asserts a structure EXISTS proves nothing here: a correct seal and a worthless one
look identical. Name the negative case.
