"use client";

/**
 * The Paralegix mark: a gavel above its sound block, on a disc.
 *
 * The disc takes `currentColor`, so it recolours with a text class. The gavel
 * is painted solid white on top rather than cut out of the disc, so it stays
 * white on every surface instead of letting the page behind show through.
 *
 * The gavel is drawn upright about its own origin (head along x, handle down
 * +y) and turned -45 degrees into place, so the parts stay readable as
 * rectangles. The head is a body plus two end caps; the gaps between them read
 * as the bands on a turned gavel. Same geometry as `/img/paralegix-mark.svg`
 * and `/img/paralegix-icon.svg`.
 */
const DISC_RADIUS = 60;
const GAVEL_TRANSFORM = "translate(52 50) rotate(-45)";
const GAVEL_HANDLE_PATH = "M-4 15 L4 15 L5.5 50 A5.5 5.5 0 0 1 -5.5 50 Z";
const GAVEL_FILL = "#FFFFFF";

/**
 * Lockup proportions, measured from the type rather than estimated.
 *
 * WORDMARK_EM   "Paralegix" in Plus Jakarta Sans 800 at -0.04em tracking
 *               advances 4.172em. Measured from the shipped font file.
 * FONT_SCALE    Wordmark size as a fraction of the disc diameter, set so the
 *               disc lands near 1.8x the wordmark's cap height. The mark still
 *               leads, but it no longer swamps the wordmark at the sizes UI
 *               chrome uses. Cap height is 0.745em, so disc / cap works out as
 *               1 / (0.745 * FONT_SCALE).
 * GAP_SCALE     Space between disc and wordmark, same basis.
 * LOCKUP_RATIO  Natural lockup width in disc diameters, derived below and
 *               padded by 2% so a fallback face with wider metrics still
 *               cannot push the wordmark outside the box the caller asked for.
 * CAP_LIFT      With `line-height: 1` the centre of the capitals sits 0.0355em
 *               below the centre of the text box, because of the descender.
 *               Lifting by that much centres the capitals on the disc, which
 *               is what the eye actually reads.
 */
const WORDMARK_EM = 4.172;
const FONT_SCALE = 0.75;
const GAP_SCALE = 0.24;
const LOCKUP_RATIO = (1 + GAP_SCALE + WORDMARK_EM * FONT_SCALE) * 1.02;
const CAP_LIFT = "-0.0355em";

/**
 * Ink values for the wordmark. These mirror the `--on-surface` token in each
 * theme, written out because `forceTheme` has to win over the active theme.
 */
const INK_ON_LIGHT = "#0D1016";
const INK_ON_DARK = "#E4E7EF";

interface ParalegixLogoProps {
  width?: number;
  height?: number;
  /**
   * Accepted and ignored. The mark is inline SVG and the wordmark is live
   * text, so there is no image for Next to preload. Kept so the many existing
   * call sites that pass it keep compiling.
   */
  priority?: boolean;
  className?: string;
  style?: React.CSSProperties;
  /**
   * Pin the logo to a single variant regardless of the active theme.
   * - "light": ink wordmark, for light backgrounds.
   * - "dark": pale wordmark, for dark backgrounds.
   * Omit for the default theme-aware behavior.
   */
  forceTheme?: "light" | "dark";
}

/**
 * Paralegix logo lockup: the mark plus the wordmark.
 *
 * `width` and `height` describe the box the logo has to fit. The lockup is
 * sized from whichever of the two binds first, so it never overflows a narrow
 * box and never crops. At the common 4:1 boxes it fills the full height.
 *
 * Pass `forceTheme` to pin a variant. Used by the marketing pages, which
 * control their own background tone independent of the app theme.
 */
export default function ParalegixLogo({
  width = 160,
  height = 40,
  className = "",
  style,
  forceTheme,
}: ParalegixLogoProps) {
  const disc = Math.min(height, width / LOCKUP_RATIO);
  const fontSize = disc * FONT_SCALE;
  const gap = disc * GAP_SCALE;

  // The disc stays cobalt in both themes, so its brightness matches
  // regardless of which surface it sits on.
  const discClass = "text-accent-solid";

  const wordColor =
    forceTheme === "dark"
      ? INK_ON_DARK
      : forceTheme === "light"
        ? INK_ON_LIGHT
        : "var(--on-surface)";

  return (
    <div
      className={`flex items-center ${className}`}
      style={{ width, height, gap, ...style }}
      role="img"
      aria-label="Paralegix"
    >
      <svg
        className={discClass}
        width={disc}
        height={disc}
        viewBox="0 0 120 120"
        fill="none"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        <circle cx="60" cy="60" r={DISC_RADIUS} fill="currentColor" />
        <g fill={GAVEL_FILL}>
          <g transform={GAVEL_TRANSFORM}>
            <rect x="-17.5" y="-11" width="35" height="22" rx="2" />
            <rect x="-32" y="-15" width="12" height="30" rx="4" />
            <rect x="20" y="-15" width="12" height="30" rx="4" />
            <rect x="-6" y="10" width="12" height="6" rx="1.5" />
            <path d={GAVEL_HANDLE_PATH} />
          </g>
          <rect x="27" y="84" width="30" height="7" rx="3" />
          <rect x="22" y="90" width="40" height="9" rx="4.5" />
        </g>
      </svg>
      <span
        style={{
          fontFamily: "var(--font-jakarta), system-ui, -apple-system, sans-serif",
          fontWeight: 700,
          fontSize,
          letterSpacing: "-0.04em",
          lineHeight: 1,
          color: wordColor,
          whiteSpace: "nowrap",
          transform: `translateY(${CAP_LIFT})`,
        }}
      >
        Paralegix
      </span>
    </div>
  );
}
