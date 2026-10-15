import { readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * WCAG 1.4.3 and 1.4.11 (AA) contrast for the colour pairs the client portal,
 * the auth pages and the marketing site actually render together.
 *
 * axe's color-contrast rule cannot run in jsdom, which has no layout or paint,
 * so this measures the tokens statically. Every colour is resolved from its
 * real definition: the app tokens from the `:root` / `.dark` blocks and the
 * fixed `mkt-*` tokens from the `@theme` block in `global.css`, the Tailwind
 * palette (`red-700`, `emerald-50`, ...) from `tailwindcss/theme.css`, and
 * the status badge colours from `constants/statusMeta.ts`. Nothing here is a
 * copied hex value, so retuning a token re-measures every pair it touches.
 *
 * `tests/styles/tokenContrast.test.ts` already holds the three text tokens on
 * every app surface, the field and control borders, and the focus ring on app
 * surfaces. This file covers what that one does not: the accent, feedback,
 * status and marketing pairs.
 *
 * Each pair names the file that renders it, and the test checks that file
 * still contains each class, so a pair cannot outlive the markup that drew it.
 */

const ROOT = join(__dirname, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const GLOBAL_CSS = read('src/styles/global.css');
// Resolved through package.json: Jest maps a bare `.css` request to a style stub.
const TAILWIND_THEME = readFileSync(join(dirname(require.resolve('tailwindcss/package.json')), 'theme.css'), 'utf8');
const STATUS_META = read('src/constants/statusMeta.ts');

type Theme = 'light' | 'dark';
type Rgba = { r: number; g: number; b: number; a: number };

/** Custom properties declared in every top-level `selector {` block of `css`. */
function declarations(css: string, selector: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const opener = new RegExp(`^${selector.replace(/[.]/g, '\\.')} \\{$`, 'gm');
  for (const match of css.matchAll(opener)) {
    const end = css.indexOf('\n}', match.index);
    for (const [, name, value] of css.slice(match.index, end).matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[name] = value.trim();
  }
  return vars;
}

const THEME_VARS: Record<Theme, Record<string, string>> = {
  light: declarations(GLOBAL_CSS, ':root'),
  dark: { ...declarations(GLOBAL_CSS, ':root'), ...declarations(GLOBAL_CSS, '.dark') },
};
const FIXED_VARS = { ...declarations(TAILWIND_THEME, '@theme default'), ...declarations(GLOBAL_CSS, '@theme') };

function srgbEncode(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** CSS Color 4 OKLCH to gamma-encoded sRGB, clipped to the sRGB gamut. */
function oklchToRgb(l: number, c: number, h: number): Rgba {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: srgbEncode(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    g: srgbEncode(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    b: srgbEncode(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
    a: 1,
  };
}

function parseColour(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255);
    return { r, g, b, a: 1 };
  }
  const rgb = value.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/);
  if (rgb) return { r: +rgb[1] / 255, g: +rgb[2] / 255, b: +rgb[3] / 255, a: rgb[4] === undefined ? 1 : +rgb[4] };
  const oklch = value.match(/^oklch\(([\d.]+)(%?) ([\d.]+) ([\d.]+)\)$/);
  if (oklch) return oklchToRgb(+oklch[1] / (oklch[2] ? 100 : 1), +oklch[3], +oklch[4]);
  throw new Error(`unsupported colour value: ${value}`);
}

/**
 * A utility colour name as written after `text-` / `bg-` (`surface`,
 * `mkt-ink`, `red-900/20`), resolved for one theme. An app token wins over a
 * fixed `@theme` colour, the same order the class names resolve in.
 */
function resolve(name: string, theme: Theme): Rgba {
  const [token, alpha] = name.split('/');
  const value = THEME_VARS[theme][token] ?? FIXED_VARS[`color-${token}`];
  if (!value) throw new Error(`no colour token named ${token}`);
  const colour = parseColour(value);
  return { ...colour, a: colour.a * (alpha === undefined ? 1 : +alpha / 100) };
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function luminance({ r, g, b }: Rgba): number {
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

interface Pair {
  /** Foreground colour name (text, icon or indicator). */
  fg: string;
  /** Background layers, bottom first. Translucent layers composite in order. */
  bg: string[];
  /** 4.5 for normal text; 3 for large text and non-text UI (1.4.11). */
  min: 4.5 | 3;
  themes: Theme[];
  /** A file that renders the pair, and the classes it must still contain. */
  uses: [file: string, classes: string[]];
}

const BOTH: Theme[] = ['light', 'dark'];
const LIGHT: Theme[] = ['light'];
const DARK: Theme[] = ['dark'];

const APP_PAIRS: Pair[] = [
  { fg: 'accent-foreground', bg: ['accent-solid'], min: 4.5, themes: BOTH, uses: ['src/components/ui/Button.tsx', ['bg-accent-solid', 'text-accent-foreground']] },
  { fg: 'accent-foreground', bg: ['accent-solid-hover'], min: 4.5, themes: BOTH, uses: ['src/components/ui/Button.tsx', ['hover:bg-accent-solid-hover', 'text-accent-foreground']] },
  { fg: 'accent-foreground', bg: ['accent-selection'], min: 4.5, themes: BOTH, uses: ['src/app/client/dashboard/page.tsx', ['bg-accent-selection', 'text-accent-foreground']] },
  { fg: 'accent-emphasis', bg: ['surface'], min: 4.5, themes: BOTH, uses: ['src/app/client/dashboard/page.tsx', ['text-accent-emphasis']] },
  { fg: 'accent-emphasis', bg: ['page'], min: 4.5, themes: BOTH, uses: ['src/app/client/dashboard/page.tsx', ['text-accent-emphasis']] },
  { fg: 'accent-emphasis-hover', bg: ['surface'], min: 4.5, themes: BOTH, uses: ['src/app/client/lawfirm/[lawFirmId]/matters/page.tsx', ['hover:text-accent-emphasis-hover']] },
  { fg: 'accent-emphasis', bg: ['surface', 'accent-soft'], min: 4.5, themes: BOTH, uses: ['src/app/client/dashboard/page.tsx', ['bg-accent-soft', 'text-accent-emphasis']] },
  { fg: 'on-surface', bg: ['surface', 'accent-soft'], min: 4.5, themes: BOTH, uses: ['src/app/client/lawfirm/[lawFirmId]/trust/page.tsx', ['bg-accent-soft', 'text-on-surface']] },
  { fg: 'on-surface', bg: ['input-bg'], min: 4.5, themes: BOTH, uses: ['src/app/client/lawfirm/[lawFirmId]/matters/page.tsx', ['bg-input-bg', 'text-on-surface']] },
  { fg: 'on-surface-secondary', bg: ['input-bg'], min: 4.5, themes: BOTH, uses: ['src/components/portalComp/UploadDocumentModal.tsx', ['bg-input-bg', 'text-on-surface-secondary']] },
  { fg: 'on-surface-muted', bg: ['input-bg'], min: 4.5, themes: BOTH, uses: ['src/app/login/LoginClient.tsx', ['bg-input-bg', 'placeholder-on-surface-muted']] },
  // The auth card is a marketing card in light mode and an app surface in dark.
  { fg: 'on-surface-muted', bg: ['mkt-card'], min: 4.5, themes: LIGHT, uses: ['src/app/login/LoginClient.tsx', ['bg-mkt-card', 'text-on-surface-muted']] },
  { fg: 'focus-ring', bg: ['mkt-paper'], min: 3, themes: LIGHT, uses: ['src/app/login/LoginClient.tsx', ['bg-mkt-paper']] },
  { fg: 'focus-ring', bg: ['mkt-card'], min: 3, themes: LIGHT, uses: ['src/app/login/LoginClient.tsx', ['bg-mkt-card']] },
];

const ERROR = 'src/components/ErrorNotification.tsx';
const SUCCESS = 'src/components/SuccessNotification.tsx';
const FEEDBACK_PAIRS: Pair[] = [
  { fg: 'red-700', bg: ['surface', 'red-50'], min: 4.5, themes: LIGHT, uses: [ERROR, ['bg-red-50', 'text-red-700']] },
  { fg: 'red-300', bg: ['surface', 'red-900/20'], min: 4.5, themes: DARK, uses: [ERROR, ['dark:bg-red-900/20', 'dark:text-red-300']] },
  { fg: 'red-600', bg: ['surface', 'red-50'], min: 4.5, themes: LIGHT, uses: [ERROR, ['text-red-600']] },
  { fg: 'red-300/90', bg: ['surface', 'red-900/20'], min: 4.5, themes: DARK, uses: [ERROR, ['dark:text-red-300/90']] },
  { fg: 'red-400', bg: ['surface', 'red-900/20', 'red-900/30'], min: 4.5, themes: DARK, uses: [ERROR, ['dark:bg-red-900/30', 'dark:text-red-400']] },
  { fg: 'red-500', bg: ['surface', 'red-50'], min: 3, themes: LIGHT, uses: [ERROR, ['text-red-500']] },
  { fg: 'emerald-700', bg: ['surface', 'emerald-50'], min: 4.5, themes: LIGHT, uses: [SUCCESS, ['bg-emerald-50', 'text-emerald-700']] },
  { fg: 'emerald-300', bg: ['surface', 'emerald-900/20'], min: 4.5, themes: DARK, uses: [SUCCESS, ['dark:bg-emerald-900/20', 'dark:text-emerald-300']] },
  { fg: 'emerald-500', bg: ['surface', 'emerald-50'], min: 3, themes: LIGHT, uses: [SUCCESS, ['text-emerald-500']] },
  { fg: 'emerald-400', bg: ['surface', 'emerald-900/20', 'emerald-900/30'], min: 3, themes: DARK, uses: [SUCCESS, ['dark:bg-emerald-900/30', 'dark:text-emerald-400']] },
  { fg: 'emerald-700', bg: ['mkt-card', 'emerald-50'], min: 4.5, themes: LIGHT, uses: ['src/app/login/LoginClient.tsx', ['bg-emerald-50', 'text-emerald-700']] },
  { fg: 'emerald-300', bg: ['surface', 'emerald-950/40'], min: 4.5, themes: DARK, uses: ['src/app/login/LoginClient.tsx', ['dark:bg-emerald-950/40', 'dark:text-emerald-300']] },
  { fg: 'red-600', bg: ['surface'], min: 4.5, themes: LIGHT, uses: ['src/components/ui/FieldError.tsx', ['text-red-600']] },
  { fg: 'red-400', bg: ['surface'], min: 4.5, themes: DARK, uses: ['src/components/ui/FieldError.tsx', ['dark:text-red-400']] },
  { fg: 'red-600', bg: ['red-50'], min: 4.5, themes: LIGHT, uses: ['src/components/ui/Button.tsx', ['hover:bg-red-50', 'text-red-600']] },
  { fg: 'red-400', bg: ['surface', 'red-950/20'], min: 4.5, themes: DARK, uses: ['src/components/ui/Button.tsx', ['dark:hover:bg-red-950/20', 'dark:text-red-400']] },
];

/** Every `StatusBadge` variant: its text class on the badge's `bg-surface`. */
const STATUS_PAIRS: Pair[] = [...STATUS_META.matchAll(/^\s+(\w+):\s*\{[^}]*text: "([^"]+)"/gm)].flatMap(([, variant, text]) => {
  const light = text.split(' ').find((c) => c.startsWith('text-'))!.slice('text-'.length);
  const dark = text.split(' ').find((c) => c.startsWith('dark:text-'))?.slice('dark:text-'.length) ?? light;
  const uses: Pair['uses'] = ['src/constants/statusMeta.ts', [`${variant}:`, ...text.split(' ')]];
  return [
    { fg: light, bg: ['surface'], min: 4.5 as const, themes: LIGHT, uses },
    { fg: dark, bg: ['surface'], min: 4.5 as const, themes: DARK, uses },
  ];
});

/** Marketing has no dark mode, so these are measured once. */
const MARKETING_PAIRS: Pair[] = [
  ...['mkt-paper', 'mkt-paper-2', 'mkt-card'].map((bg) => ({ fg: 'mkt-ink', bg: [bg], min: 4.5 as const, themes: LIGHT, uses: ['src/components/marketingComp/primitives.tsx', ['text-mkt-ink']] as Pair['uses'] })),
  ...['mkt-paper', 'mkt-card'].map((bg) => ({ fg: 'mkt-ink-2', bg: [bg], min: 4.5 as const, themes: LIGHT, uses: ['src/components/marketingComp/MarketingFooter.tsx', ['text-mkt-ink-2']] as Pair['uses'] })),
  ...['mkt-paper', 'mkt-card'].map((bg) => ({ fg: 'mkt-ink-3', bg: [bg], min: 4.5 as const, themes: LIGHT, uses: ['src/components/marketingComp/MarketingFooter.tsx', ['text-mkt-ink-3']] as Pair['uses'] })),
  ...['mkt-paper', 'mkt-card'].map((bg) => ({ fg: 'mkt-accent-deep', bg: [bg], min: 4.5 as const, themes: LIGHT, uses: ['src/components/marketingComp/primitives.tsx', ['text-mkt-accent-deep']] as Pair['uses'] })),
  { fg: 'mkt-accent-deep', bg: ['mkt-paper', 'mkt-accent-soft'], min: 4.5, themes: LIGHT, uses: ['src/app/features/page.tsx', ['bg-mkt-accent-soft', 'text-mkt-accent-deep']] },
  // The 13px eyebrow and the italic heading words on the dark showcase band.
  { fg: 'mkt-accent', bg: ['mkt-ink'], min: 4.5, themes: LIGHT, uses: ['src/app/page.tsx', ['bg-mkt-ink', 'text-mkt-accent']] },
  { fg: 'mkt-paper', bg: ['mkt-ink'], min: 4.5, themes: LIGHT, uses: ['src/components/marketingComp/primitives.tsx', ['bg-mkt-ink', 'text-mkt-paper']] },
  // The accent button and the pricing "popular" badge (11px bold, normal text).
  { fg: 'white', bg: ['mkt-accent'], min: 4.5, themes: LIGHT, uses: ['src/components/marketingComp/primitives.tsx', ['bg-mkt-accent', 'text-white']] },
  { fg: 'white', bg: ['mkt-accent-deep'], min: 4.5, themes: LIGHT, uses: ['src/components/marketingComp/primitives.tsx', ['hover:bg-mkt-accent-deep', 'text-white']] },
  // Practice-area names under the hero sit in an `opacity-75` row.
  { fg: 'mkt-ink/75', bg: ['mkt-paper'], min: 4.5, themes: LIGHT, uses: ['src/app/page.tsx', ['opacity-75']] },
];

const PAIRS = [...APP_PAIRS, ...FEEDBACK_PAIRS, ...STATUS_PAIRS, ...MARKETING_PAIRS];

function measure(pair: Pair, theme: Theme) {
  const background = pair.bg.reduce<Rgba>((under, layer) => over(resolve(layer, theme), under), resolve(pair.bg[0], theme));
  return contrastRatio(over(resolve(pair.fg, theme), background), background);
}

const label = (pair: Pair, theme: Theme) => `${theme} ${pair.fg} on ${pair.bg.join(' + ')}`;

/**
 * Pairs that ship below their WCAG minimum today, with the measured ratio.
 * The fix is a token decision for the design owner, not a change to make
 * here: retuning a shared token changes every screen that uses it. When a
 * token or class moves, update this list in the same change; the test fails
 * both when a new pair drops below the bar and when a listed one is fixed.
 */
const KNOWN_FAILURES: Record<string, number> = {
  // Every primary Button, and the selected item on the client dashboard.
  'dark accent-foreground on accent-solid': 4.08,
  'dark accent-foreground on accent-solid-hover': 3.49,
  'dark accent-foreground on accent-selection': 4.08,
  // Accent chips and selected rows on the client dashboard, matters and billing.
  'dark accent-emphasis on surface + accent-soft': 4.29,
  // StatusBadge text for the success, warning, teal, cyan and pink variants.
  'light emerald-600 on surface': 3.48,
  'light amber-600 on surface': 3.03,
  'light teal-600 on surface': 3.47,
  'light cyan-600 on surface': 3.42,
  'light pink-600 on surface': 4.32,
  // ErrorNotification field-error lines and its Retry button; the danger
  // Button on hover.
  'light red-600 on surface + red-50': 4.36,
  'light red-600 on red-50': 4.36,
  // SuccessNotification's dismiss icon (a non-text control, 3:1).
  'light emerald-500 on surface + emerald-50': 2.34,
  // Homepage workflow band: the 13px eyebrow and the step numbers.
  'light mkt-accent on mkt-ink': 4.02,
  // Marketing footer headings and fine print, and the hero logo-strip eyebrow.
  'light mkt-ink-3 on mkt-paper': 4.49,
  // The marketing accent button and the pricing "popular" badge.
  'light white on mkt-accent': 4,
};

describe('client and public surface colour contrast', () => {
  it('measures at least one pair from each family in each theme', () => {
    expect(STATUS_PAIRS.length).toBeGreaterThanOrEqual(20);
    for (const theme of BOTH) {
      for (const family of [APP_PAIRS, FEEDBACK_PAIRS, STATUS_PAIRS]) {
        expect(family.some((pair) => pair.themes.includes(theme))).toBe(true);
      }
    }
  });

  it.each(PAIRS.map((pair) => [`${pair.fg} on ${pair.bg.join(' + ')} (${pair.uses[0]})`, pair] as const))(
    'still renders %s',
    (_name, pair) => {
      const source = read(pair.uses[0]);
      for (const cls of pair.uses[1]) expect({ file: pair.uses[0], cls, present: source.includes(cls) }).toEqual({ file: pair.uses[0], cls, present: true });
    },
  );

  it('fails only the pairs listed as known failures, at their measured ratios', () => {
    const failing: Record<string, number> = {};
    for (const pair of PAIRS) {
      for (const theme of pair.themes) {
        const ratio = measure(pair, theme);
        if (ratio < pair.min) failing[label(pair, theme)] = Number(ratio.toFixed(2));
      }
    }
    expect(failing).toEqual(KNOWN_FAILURES);
  });
});

describe('colour resolution', () => {
  it('returns 21 for black on white and 1 for a colour on itself', () => {
    expect(contrastRatio(parseColour('#000'), parseColour('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrastRatio(resolve('surface', 'light'), resolve('surface', 'light'))).toBeCloseTo(1, 5);
  });

  it('converts OKLCH through the CSS Color 4 matrices', () => {
    // oklch(62.8% 0.2577 29.23) is the spec's sRGB red; white is L = 1.
    const red = parseColour('oklch(62.8% 0.2577 29.23)');
    expect([red.r, red.g, red.b].map((c) => Math.round(c * 255))).toEqual([255, 0, 0]);
    expect(parseColour('oklch(1 0 0)')).toMatchObject({ r: expect.closeTo(1, 3), g: expect.closeTo(1, 3), b: expect.closeTo(1, 3) });
  });

  it('reads app tokens per theme and fixed tokens from their @theme blocks', () => {
    expect(resolve('surface', 'light')).not.toEqual(resolve('surface', 'dark'));
    expect(resolve('mkt-paper', 'light')).toEqual(resolve('mkt-paper', 'dark'));
    expect(resolve('red-900/20', 'dark').a).toBeCloseTo(0.2, 5);
    expect(resolve('accent-soft', 'light').a).toBeCloseTo(0.1, 5);
    expect(() => resolve('not-a-token', 'light')).toThrow('no colour token named not-a-token');
  });

  it('composites a translucent layer over the colour beneath it', () => {
    const half = { r: 0, g: 0, b: 0, a: 0.5 };
    expect(over(half, { r: 1, g: 1, b: 1, a: 1 })).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
  });
});
