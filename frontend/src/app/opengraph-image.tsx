import { ImageResponse } from 'next/og';

/**
 * Site-wide social preview card. Generated rather than shipped as an asset so it
 * stays in step with the marketing palette in `global.css` - the hex values here
 * are the resolved `--color-mkt-*` tokens (the accents are oklch in CSS, which
 * Satori does not parse, so they are converted).
 *
 * Routes inherit this unless they define their own `opengraph-image`.
 */
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Paralegix: legal practice management software';

const PAPER = '#f7f4ed';
const INK = '#16222f';
const INK_2 = '#3a4856';
const ACCENT = '#a07844';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: PAPER,
          padding: '72px 80px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: ACCENT, display: 'flex' }} />
          <div
            style={{
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: INK_2,
            }}
          >
            Paralegix
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              fontSize: 82,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
              color: INK,
              maxWidth: 940,
              display: 'flex',
              flexWrap: 'wrap',
            }}
          >
            Every matter, deadline &amp; dollar, in one place.
          </div>
          <div style={{ display: 'flex', width: 132, height: 6, backgroundColor: ACCENT, marginTop: 40 }} />
        </div>

        <div style={{ fontSize: 30, color: INK_2, maxWidth: 900, lineHeight: 1.4, display: 'flex' }}>
          Matter management, documents, calendaring, trust accounting, and billing
          for law firms.
        </div>
      </div>
    ),
    size,
  );
}
