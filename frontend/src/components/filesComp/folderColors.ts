// Single source of truth for folder colors across every file view (matter/task
// file manager, the firm-wide Files page, and the client portal). A folder's
// `folderColor` key (chosen via the color picker) maps to one definition here so
// the same folder looks identical everywhere. Folders without a chosen color
// fall back to amber (the neutral default) instead of a per-view ad-hoc tone.

export interface FolderColorDef {
  bg: string;
  border: string;
  icon: string;
  label: string;
  darkBg: string;
  darkBorder: string;
  /** Solid fill used for the compact color-picker swatch. */
  swatch: string;
  /** Ring color shown around the selected swatch in the color picker. */
  ring: string;
}

export const FOLDER_COLORS: Record<string, FolderColorDef> = {
  amber: { bg: 'bg-amber-50', border: 'border-amber-300', icon: 'text-amber-500 dark:text-amber-400', label: 'bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30', darkBg: 'dark:bg-amber-500/10', darkBorder: 'dark:border-amber-500/40', swatch: 'bg-amber-500', ring: 'ring-amber-500' },
  blue: { bg: 'bg-blue-50', border: 'border-blue-300', icon: 'text-blue-600 dark:text-blue-400', label: 'bg-blue-100 text-blue-800 border border-blue-300 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30', darkBg: 'dark:bg-blue-500/10', darkBorder: 'dark:border-blue-500/40', swatch: 'bg-blue-500', ring: 'ring-blue-500' },
  green: { bg: 'bg-green-50', border: 'border-green-300', icon: 'text-green-600 dark:text-green-400', label: 'bg-green-100 text-green-800 border border-green-300 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/30', darkBg: 'dark:bg-green-500/10', darkBorder: 'dark:border-green-500/40', swatch: 'bg-green-500', ring: 'ring-green-500' },
  red: { bg: 'bg-red-50', border: 'border-red-300', icon: 'text-red-600 dark:text-red-400', label: 'bg-red-100 text-red-800 border border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30', darkBg: 'dark:bg-red-500/10', darkBorder: 'dark:border-red-500/40', swatch: 'bg-red-500', ring: 'ring-red-500' },
  yellow: { bg: 'bg-yellow-50', border: 'border-yellow-300', icon: 'text-yellow-600 dark:text-yellow-400', label: 'bg-yellow-100 text-yellow-800 border border-yellow-300 dark:bg-yellow-500/15 dark:text-yellow-300 dark:border-yellow-500/30', darkBg: 'dark:bg-yellow-500/10', darkBorder: 'dark:border-yellow-500/40', swatch: 'bg-yellow-400', ring: 'ring-yellow-400' },
  purple: { bg: 'bg-purple-50', border: 'border-purple-300', icon: 'text-purple-600 dark:text-purple-400', label: 'bg-purple-100 text-purple-800 border border-purple-300 dark:bg-purple-500/15 dark:text-purple-300 dark:border-purple-500/30', darkBg: 'dark:bg-purple-500/10', darkBorder: 'dark:border-purple-500/40', swatch: 'bg-purple-500', ring: 'ring-purple-500' },
  orange: { bg: 'bg-orange-50', border: 'border-orange-300', icon: 'text-orange-600 dark:text-orange-400', label: 'bg-orange-100 text-orange-800 border border-orange-300 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/30', darkBg: 'dark:bg-orange-500/10', darkBorder: 'dark:border-orange-500/40', swatch: 'bg-orange-500', ring: 'ring-orange-500' },
  teal: { bg: 'bg-teal-50', border: 'border-teal-300', icon: 'text-teal-600 dark:text-teal-400', label: 'bg-teal-100 text-teal-800 border border-teal-300 dark:bg-teal-500/15 dark:text-teal-300 dark:border-teal-500/30', darkBg: 'dark:bg-teal-500/10', darkBorder: 'dark:border-teal-500/40', swatch: 'bg-teal-500', ring: 'ring-teal-500' },
  fuchsia: { bg: 'bg-fuchsia-50', border: 'border-fuchsia-300', icon: 'text-fuchsia-600 dark:text-fuchsia-400', label: 'bg-fuchsia-100 text-fuchsia-800 border border-fuchsia-300 dark:bg-fuchsia-500/15 dark:text-fuchsia-300 dark:border-fuchsia-500/30', darkBg: 'dark:bg-fuchsia-500/10', darkBorder: 'dark:border-fuchsia-500/40', swatch: 'bg-fuchsia-500', ring: 'ring-fuchsia-500' },
};

export const DEFAULT_FOLDER_COLOR = 'amber';

// Resolve a folder's stored color key to its definition. Unknown or missing
// keys fall back to amber so every view renders the same neutral default.
export function getFolderColorDef(colorKey?: string | null): FolderColorDef {
  if (colorKey && colorKey in FOLDER_COLORS) {
    return FOLDER_COLORS[colorKey];
  }
  return FOLDER_COLORS[DEFAULT_FOLDER_COLOR];
}
