/**
 * Approximate location for a client IP, from the MaxMind GeoLite data that
 * ships inside the `geoip-lite` package, WITHOUT loading that package.
 *
 * `require('geoip-lite')` reads `geoip-city.dat`, `geoip-city6.dat` and
 * `geoip-city-names.dat` into Buffers at require time: about 104 MB held for the
 * life of the process, inside a 512 MiB container, to serve one lookup per
 * login. This module reads the same files by path and binary-searches them with
 * positioned reads, so a lookup costs a few dozen small reads and a few hundred
 * bytes of memory. The page cache, not the heap, holds whatever is hot.
 *
 * The record layout and decoding below replicate `geoip-lite` 2.0.3
 * (`lib/geoip.js` `lookup4`/`lookup6`, `lib/utils.js` `aton4`/`aton6`) exactly,
 * including its quirks, so the answer is the one that package would give.
 * `tests/shared/geoip.test.ts` compares the two across a spread of addresses.
 * Re-run it after upgrading `geoip-lite`: a new data layout would show up there.
 *
 * Only the city databases are read. geoip-lite falls back to its country-only
 * files when the city files are missing or empty; the published package always
 * carries the city files, and a missing one here makes the lookup return null.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

/**
 * Resolved from the package's `package.json`, never from its main module:
 * resolving `geoip-lite` itself is harmless, but a `require` of it is exactly
 * the preload this file exists to avoid.
 */
function dataDir(): string {
  return path.join(path.dirname(require.resolve('geoip-lite/package.json')), 'data');
}

const CITY4_FILE = 'geoip-city.dat';
const CITY6_FILE = 'geoip-city6.dat';
const CITY_NAMES_FILE = 'geoip-city-names.dat';

/** Bytes per IPv4 range record: floor u32, ceil u32, location id u32, lat i32, lon i32, area u32. */
const RECORD_SIZE4 = 24;
/** Bytes per IPv6 range record: floor 2x u32 padded to 16, ceil likewise, then the IPv4 tail. */
const RECORD_SIZE6 = 48;
/** Bytes per location record in the names file. */
const LOCATION_RECORD_SIZE = 88;
/** The location id a range carries when MaxMind has no location for it. */
const NO_LOCATION = -1 >>> 0;

function aton4(a: string): number {
  let n = 0;
  let octet = 0;
  for (let i = 0, len = a.length; i <= len; i += 1) {
    if (i === len || a.charCodeAt(i) === 46) {
      n = ((n << 8) | octet) >>> 0;
      octet = 0;
    } else {
      octet = octet * 10 + (a.charCodeAt(i) - 48);
    }
  }
  return n;
}

function aton6(input: string): number[] {
  const a: any[] = input.replace(/"/g, '').split(/:/);
  const l = a.length - 1;

  if (a[l] === '') a[l] = 0;

  if (l < 7) {
    const omitted = 8 - a.length;
    const omitStart = a.indexOf('');
    const omitEnd = omitStart + 8 - a.length;
    for (let i = 7; i >= omitStart; i -= 1) {
      if (i > omitEnd) a[i] = a[i - omitted];
      else a[i] = 0;
    }
  }

  for (let i = 0; i < 8; i += 1) {
    a[i] = a[i] ? parseInt(a[i], 16) : 0;
  }

  const r: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    r.push(((a[2 * i] << 16) + a[2 * i + 1]) >>> 0);
  }
  return r;
}

function cmp6(a: number[], b: number[]): number {
  if (a[0] < b[0]) return -1;
  if (a[0] > b[0]) return 1;
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return 0;
}

const PRIVATE_RANGES4: Array<[number, number]> = [
  [aton4('10.0.0.0'), aton4('10.255.255.255')],
  [aton4('172.16.0.0'), aton4('172.31.255.255')],
  [aton4('192.168.0.0'), aton4('192.168.255.255')],
];

/** A string field of a fixed-width record: stops at the first NUL inside the field. */
function bufstr(buf: Buffer, start: number, end: number): string {
  const nullPos = buf.indexOf(0, start);
  const stop = nullPos >= start && nullPos < end ? nullPos : end;
  return buf.toString('utf8', start, stop);
}

type Handle = fs.promises.FileHandle;

async function readAt(handle: Handle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

async function withFile<T>(fileName: string, work: (handle: Handle, size: number) => Promise<T>): Promise<T> {
  const handle = await fs.promises.open(path.join(dataDir(), fileName), 'r');
  try {
    const { size } = await handle.stat();
    return await work(handle, size);
  } finally {
    await handle.close();
  }
}

/** The location fields both tables share, decoded from one names-file record. */
async function readLocation(locId: number) {
  const loc = await withFile(CITY_NAMES_FILE, (names) => (
    readAt(names, locId * LOCATION_RECORD_SIZE, LOCATION_RECORD_SIZE)
  ));
  return {
    country: bufstr(loc, 0, 2),
    region: bufstr(loc, 2, 5),
    metro: loc.readInt32BE(5),
    eu: bufstr(loc, 9, 10),
    timezone: bufstr(loc, 10, 42),
    city: bufstr(loc, 42, LOCATION_RECORD_SIZE),
  };
}

/**
 * The geoip-lite binary search, over reads rather than a buffer.
 *
 * `bounds(line)` answers the record's floor and ceil; `below`/`above` compare
 * them with the address. The loop, including how it narrows the last two lines,
 * is geoip-lite's, so it visits the same records and stops in the same place.
 */
async function searchLines<K>(
  lastLine: number,
  ip: K,
  bounds: (line: number) => Promise<[K, K]>,
  compare: (a: K, b: K) => number,
): Promise<number | null> {
  let fline = 0;
  let cline = lastLine;
  for (;;) {
    const line = (fline + cline) >>> 1;
    // eslint-disable-next-line no-await-in-loop -- a binary search is sequential by nature
    const [floor, ceil] = await bounds(line);
    if (compare(floor, ip) <= 0 && compare(ceil, ip) >= 0) return line;
    if (fline === cline) return null;
    if (fline === cline - 1) {
      if (line === fline) fline = cline;
      else cline = fline;
    } else if (compare(floor, ip) > 0) {
      cline = line;
    } else if (compare(ceil, ip) < 0) {
      fline = line;
    }
  }
}

const cmp4 = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

async function lookup4(ip: number) {
  return withFile(CITY4_FILE, async (main, size) => {
    const lastLine = size / RECORD_SIZE4 - 1;
    const firstIP = (await readAt(main, 0, 4)).readUInt32BE(0);
    const lastIP = (await readAt(main, lastLine * RECORD_SIZE4 + 4, 4)).readUInt32BE(0);
    if (ip > lastIP || ip < firstIP) return null;
    for (const [low, high] of PRIVATE_RANGES4) {
      if (ip >= low && ip <= high) return null;
    }

    let record: Buffer = Buffer.alloc(0);
    const line = await searchLines(lastLine, ip, async (l) => {
      record = await readAt(main, l * RECORD_SIZE4, RECORD_SIZE4);
      return [record.readUInt32BE(0), record.readUInt32BE(4)];
    }, cmp4);
    if (line === null) return null;

    const floor = record.readUInt32BE(0);
    const ceil = record.readUInt32BE(4);
    const geodata: Record<string, any> = {
      range: [floor, ceil],
      country: '',
      region: '',
      eu: '',
      timezone: '',
      city: '',
      ll: [null, null],
    };
    const locId = record.readUInt32BE(8);
    if (NO_LOCATION > locId) {
      const loc = await readLocation(locId);
      geodata.country = loc.country;
      geodata.region = loc.region;
      geodata.metro = loc.metro;
      geodata.ll[0] = record.readInt32BE(12) / 10000;
      geodata.ll[1] = record.readInt32BE(16) / 10000;
      geodata.area = record.readUInt32BE(20);
      geodata.eu = loc.eu;
      geodata.timezone = loc.timezone;
      geodata.city = loc.city;
    }
    return geodata;
  });
}

async function lookup6(ip: number[]) {
  return withFile(CITY6_FILE, async (main, size) => {
    const lastLine = size / RECORD_SIZE6 - 1;
    const readIp6 = async (line: number, offset: number) => {
      const b = await readAt(main, line * RECORD_SIZE6 + offset * 16, 8);
      return [b.readUInt32BE(0), b.readUInt32BE(4)];
    };
    const firstIP = await readIp6(0, 0);
    const lastIP = await readIp6(lastLine, 1);
    if (cmp6(ip, lastIP) > 0 || cmp6(ip, firstIP) < 0) return null;

    let record: Buffer = Buffer.alloc(0);
    const line = await searchLines(lastLine, ip, async (l) => {
      record = await readAt(main, l * RECORD_SIZE6, RECORD_SIZE6);
      return [
        [record.readUInt32BE(0), record.readUInt32BE(4)],
        [record.readUInt32BE(16), record.readUInt32BE(20)],
      ];
    }, cmp6);
    if (line === null) return null;

    const geodata: Record<string, any> = {
      range: '',
      country: '',
      region: '',
      city: '',
      ll: [0, 0],
    };
    const locId = record.readUInt32BE(32);
    if (NO_LOCATION > locId) {
      const loc = await readLocation(locId);
      geodata.country = loc.country;
      geodata.region = loc.region;
      geodata.metro = loc.metro;
      geodata.ll[0] = record.readInt32BE(36) / 10000;
      geodata.ll[1] = record.readInt32BE(40) / 10000;
      geodata.area = record.readUInt32BE(44);
      geodata.eu = loc.eu;
      geodata.timezone = loc.timezone;
      geodata.city = loc.city;
    }
    return geodata;
  });
}

function get4mapped(ip: string): string | null {
  const ipv6 = ip.toUpperCase();
  for (const prefix of ['0:0:0:0:0:FFFF:', '::FFFF:']) {
    if (ipv6.indexOf(prefix) === 0) return ipv6.substring(prefix.length);
  }
  return null;
}

/**
 * The record `geoip-lite`'s `lookup(ip)` would return for this address, or null.
 *
 * Same shape, field for field, including `range`, `metro`, `area` and `eu`.
 * Throws on an unreadable data file; `lookupLocation` is the best-effort caller.
 */
export async function lookupGeoRecord(ip: string): Promise<Record<string, any> | null> {
  if (!ip) return null;
  const version = net.isIP(ip);
  if (version === 4) return lookup4(aton4(ip));
  if (version === 6) {
    const ipv4 = get4mapped(ip);
    return ipv4 ? lookup4(aton4(ipv4)) : lookup6(aton6(ip));
  }
  return null;
}

/**
 * Normalize an Express req.ip into a plain address a geo lookup can use.
 * Strips the IPv4-mapped IPv6 prefix ("::ffff:1.2.3.4" -> "1.2.3.4") and any
 * zone/port noise. Returns null for empty/loopback/private inputs where a
 * geo lookup is meaningless.
 */
export function normalizeIp(ip: unknown): string | null {
  if (!ip || typeof ip !== 'string') return null;
  let addr = ip.trim();
  // req.ip is a single address, but a raw x-forwarded-for can be a list.
  if (addr.includes(',')) addr = addr.split(',')[0].trim();
  if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length);
  if (!addr || addr === '::1' || addr === '127.0.0.1' || addr === 'localhost') return null;
  return addr;
}

/**
 * Resolve an approximate location for a client IP using the bundled offline
 * MaxMind database (no network call, no API key). Returns a small, safe shape
 * suitable for storing in an audit event's metadata, or null when the IP is
 * private/unknown. City-level accuracy is approximate by design.
 */
export async function lookupLocation(ip: unknown): Promise<Record<string, unknown> | null> {
  try {
    const addr = normalizeIp(ip);
    if (!addr) return null;
    const geo = await lookupGeoRecord(addr);
    if (!geo) return null;
    return {
      city: geo.city || null,
      region: geo.region || null,
      country: geo.country || null,
      timezone: geo.timezone || null,
      // [latitude, longitude]
      coordinates: Array.isArray(geo.ll) && geo.ll.length === 2 ? geo.ll : null,
    };
  } catch (err) {
    // Geo lookup is best-effort; never let it break the caller.
    console.error('geoip lookupLocation failed:', err);
    return null;
  }
}
