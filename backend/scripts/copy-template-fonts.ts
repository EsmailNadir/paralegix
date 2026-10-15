#!/usr/bin/env node

// tsc only emits compiled .ts sources into dist/, so the Document Overlay
// editor's bundled font files (src/modules/templates/fonts/*.ttf) would
// never reach dist/ - and therefore never reach the production image, whose
// Dockerfile copies dist/ only - without an explicit copy step after `tsc`.
// Run as part of `npm run build` (and `dev:dist`, which builds first too).

const fs = require('fs');
const path = require('path');

// Two font folders: the Document Overlay editor's fonts, and the Liberation
// Sans fallback the Word-first library draws non-WinAnsi PDF form values in.
const FONT_DIRS = [
  ['modules', 'templates', 'fonts'],
  ['modules', 'wordTemplates', 'lib', 'fonts'],
];

for (const segments of FONT_DIRS) {
  const src = path.join(__dirname, '..', 'src', ...segments);
  const dest = path.join(__dirname, '..', 'dist', ...segments);
  if (!fs.existsSync(src)) {
    throw new Error(`Template font source directory not found: ${src}`);
  }
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[build] Copied template fonts -> ${dest}`);
}
