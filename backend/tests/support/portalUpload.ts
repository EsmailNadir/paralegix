/**
 * A client portal document upload, driven end to end from a spec.
 *
 * The portal's document routes are a PAIR now: `upload-init` claims a file row
 * and mints a storage session, the browser PUTs the bytes, and
 * `upload-finalize` verifies what landed and stamps the row. They used to be a
 * single multipart POST that carried up to ten files through the API container.
 *
 * Specs care about the outcome, not the three legs, so this performs all of
 * them and returns whichever response is the interesting one: the INIT response
 * when it refused, because that is where an authorization failure appears and
 * the finalize never happens, and the finalize response otherwise.
 *
 * `land` is the caller's bucket harness playing the browser's part, because the
 * two harnesses in this suite spell it differently.
 */
import { landUpload } from './inMemoryBucket';

export interface PortalUploadFile {
  name: string;
  size?: number;
  contentType?: string;
  /** Leading bytes, when the spec is about what the admission sniff reads. */
  head?: Buffer;
}

/** A PDF header, so an ordinary upload passes the executable sniff. */
export const PDF_HEAD = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

export interface PortalUploadOptions {
  /** Plays the browser's PUT. Defaults to the in-memory bucket's own. */
  land?: (objectPath: string, opts: { bytes: number; contentType?: string; head?: Buffer }) => void;
  /** Extra query string already on the url, e.g. `?clientRecordId=...`. */
  query?: string;
  actionKey?: string;
}

/**
 * Run one upload against a portal document route.
 *
 * `baseUrl` is the route WITHOUT the `/upload-init` or `/upload-finalize`
 * suffix, so a spec names the same path it always did.
 */
export async function portalUpload(
  actor: { api: any },
  baseUrl: string,
  files: PortalUploadFile[],
  options: PortalUploadOptions = {},
) {
  const { land = landUpload, query = '' } = options;
  const declared = files.map((f) => ({
    fileName: f.name,
    contentType: f.contentType ?? 'application/pdf',
    size: f.size ?? 1024,
  }));

  const opened = await actor.api.post(`${baseUrl}/upload-init${query}`).send({ files: declared, actionKey: options.actionKey });
  // A refusal is the whole answer: no session exists, so nothing can be landed
  // and finalize would have nothing to stamp.
  if (opened.status !== 200) return opened;

  opened.body.uploads.forEach((upload: any, i: number) => {
    land(upload.objectPath, {
      bytes: declared[i].size,
      contentType: declared[i].contentType,
      head: files[i].head ?? PDF_HEAD,
    });
  });

  return actor.api.post(`${baseUrl}/upload-finalize${query}`).send({
    uploads: opened.body.uploads,
    reservedBytes: opened.body.reservedBytes,
  });
}
