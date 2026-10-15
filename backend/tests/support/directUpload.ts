/**
 * Shared pieces of the direct-to-storage upload specs: the init/land/finalize
 * flow where the browser writes bytes straight to the bucket and the server
 * only signs, then checks what storage recorded.
 *
 * The magic-byte sniff reads the first bytes of the stored object, so a landed
 * object needs a real header. `PDF_HEAD` passes as a PDF; `EXE_HEAD` is a
 * Windows executable header, which the deny-list must refuse whatever the
 * declared content type says.
 */
import { testPool } from './db';
import { landUpload } from './inMemoryBucket';

export const PDF_HEAD = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
export const EXE_HEAD = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

/** One file as the browser declares it to upload-init. */
export const declaredPdf = (fileName: string, size: number) => ({
  fileName, contentType: 'application/pdf', size,
});

/** Lands every opened upload in the bucket as a PDF of `bytes`, unless `over` says otherwise. */
export function landAll(uploads: any[], bytes: number, over: Record<string, unknown> = {}) {
  for (const u of uploads) {
    landUpload(u.objectPath, { bytes, contentType: 'application/pdf', head: PDF_HEAD, ...over });
  }
}

/** Saved bytes, and the bytes live upload reservations are holding. */
export async function storageUsageOf(lawFirmId: string): Promise<{ used: number; reserved: number }> {
  const { rows } = await testPool.query(
    `select f.storage_used_bytes,
            (select coalesce(sum(r.bytes), 0) from storage_reservations r
              where r.law_firm_id = f.id and r.expires_at > now()) as held
       from law_firms f where f.id = $1`, [lawFirmId],
  );
  return { used: Number(rows[0].storage_used_bytes || 0), reserved: Number(rows[0].held || 0) };
}
