/**
 * The login audit's IP location, read from disk instead of from memory.
 *
 * `geoip-lite` loads its whole city database into Buffers the moment it is
 * required: about 104 MB of a 512 MiB container, held for the life of the
 * process, to answer a question asked once per login. `src/shared/utils/geoip.ts`
 * reads the SAME data files with positioned reads instead.
 *
 * Two things have to hold, and each has its own test:
 *   - the answers are the answers geoip-lite gives, record for record, because
 *     the admin audit UI shows and searches city, region and country;
 *   - geoip-lite's main module is never loaded, because loading it at all is
 *     the 104 MB this exists to avoid.
 */
const realGeoip = jest.requireActual('geoip-lite');
const { lookupGeoRecord, lookupLocation } = require('../../src/shared/utils/geoip');

/** A deterministic spread of addresses, so the comparison covers more than hand-picked ones. */
function spreadIpv4(count: number): string[] {
  const out: string[] = [];
  let seed = 0x9e3779b9;
  for (let i = 0; i < count; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    out.push([seed >>> 24, (seed >>> 16) & 0xff, (seed >>> 8) & 0xff, seed & 0xff].join('.'));
  }
  return out;
}

function spreadIpv6(count: number): string[] {
  const out: string[] = [];
  let seed = 0x7f4a7c15;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < count; i += 1) {
    // Global unicast (2000::/3), where nearly all of the allocated space is.
    const first = 0x2000 + (next() % 0x2000);
    const groups = [first];
    for (let g = 0; g < 7; g += 1) groups.push(next() & 0xffff);
    out.push(groups.map((n) => n.toString(16)).join(':'));
  }
  return out;
}

const HAND_PICKED_V4 = [
  '8.8.8.8', '1.1.1.1', '81.2.69.142', '89.160.20.112', '216.160.83.56',
  '175.16.199.0', '41.206.32.1', '200.160.2.3', '203.0.113.5', '100.64.0.1',
  // Private ranges geoip-lite refuses outright.
  '10.1.2.3', '172.16.5.4', '172.31.255.255', '192.168.1.1',
  // The ends of the address space.
  '0.0.0.0', '0.0.0.1', '255.255.255.255', '224.0.0.1',
];

const HAND_PICKED_V6 = [
  '2001:4860:4860::8888', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e',
  '2c0f:fb50:4003::', '2400:cb00::1', '2001:db8::1', 'fe80::1', '::', '::1',
  'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  // IPv4-mapped forms, which geoip-lite answers from the IPv4 table.
  '::ffff:8.8.8.8', '0:0:0:0:0:ffff:81.2.69.142',
];

describe('lookupGeoRecord', () => {
  it('answers exactly what geoip-lite answers, for found, missing and private addresses', async () => {
    const addresses = [
      ...HAND_PICKED_V4, ...HAND_PICKED_V6, ...spreadIpv4(400), ...spreadIpv6(200),
    ];

    const mismatches: Array<{ ip: string; expected: unknown; actual: unknown }> = [];
    let found = 0;
    for (const ip of addresses) {
      // eslint-disable-next-line no-await-in-loop -- one comparison at a time keeps a failure readable
      const actual = await lookupGeoRecord(ip);
      const expected = realGeoip.lookup(ip);
      if (expected && expected.city) found += 1;
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        // JSON, not toEqual: it also catches a key present on one side only.
        mismatches.push({ ip, expected, actual });
      }
    }

    expect(mismatches).toEqual([]);
    // The spread has to actually reach city records, or it compared nulls.
    expect(found).toBeGreaterThan(50);
    expect(await lookupGeoRecord('10.1.2.3')).toBeNull();
    expect(await lookupGeoRecord('2001:db8::1')).toBeNull();
  });
});

describe('lookupLocation', () => {
  it('returns the city, region, country, timezone and coordinates geoip-lite reports', async () => {
    const expected = realGeoip.lookup('81.2.69.142');
    expect(expected.city).toBeTruthy();

    expect(await lookupLocation('::ffff:81.2.69.142')).toEqual({
      city: expected.city,
      region: expected.region,
      country: expected.country,
      timezone: expected.timezone,
      coordinates: expected.ll,
    });
  });

  it('returns null for loopback, private and unparseable input rather than throwing', async () => {
    expect(await lookupLocation('127.0.0.1')).toBeNull();
    expect(await lookupLocation('192.168.1.1')).toBeNull();
    expect(await lookupLocation('not an ip')).toBeNull();
    expect(await lookupLocation(undefined)).toBeNull();
  });

  it('never loads the geoip-lite main module, which preloads the whole database', async () => {
    let location: unknown;
    let loaded: any;
    jest.isolateModules(() => {
      jest.doMock('geoip-lite', () => {
        throw new Error('geoip-lite main module was loaded');
      });
      loaded = require('../../src/shared/utils/geoip');
    });
    try {
      location = await loaded.lookupLocation('81.2.69.142');
    } finally {
      jest.dontMock('geoip-lite');
    }

    // Not just "did not throw": lookupLocation swallows errors into null, so a
    // module that did load geoip-lite would pass a bare no-throw check.
    expect(location).toEqual(expect.objectContaining({ city: realGeoip.lookup('81.2.69.142').city }));
  });
});
