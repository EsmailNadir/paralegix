#!/usr/bin/env node
/**
 * Forbids hand-rolling a modal dialog outside `components/ui/Modal`.
 *
 * `<Modal>` owns the overlay, the focus trap, Escape, the open/close
 * animation, the bottom sheet on a phone, and stacking over another dialog
 * (`stacked`). A component that renders its own `role="dialog"` is a copy of
 * that shell, and copies drift: the app once had fifteen, with their own
 * z-index, radius and height cap, each missing a different later fix. Most
 * existed because the shell could not open on top of another dialog, which
 * `stacked` now covers.
 *
 * The files below render `role="dialog"` for something that is not a modal
 * dialog (a date picker popover, a mobile navigation drawer, the full-screen
 * document viewer). Add to the list only for the same kind of reason.
 *
 *   node scripts/check-dialog-shell.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, '..', 'src');

const ALLOWED = new Set([
  'components/ui/Modal.tsx',
  'components/ui/DatePicker.tsx',
  'components/ui/DateRangePicker.tsx',
  'components/ui/DateTimePicker.tsx',
  'components/sidebar/ClientSidebar.tsx',
  'components/calendarComp/Calendar.tsx',
  'components/filesComp/DocumentPreviewOverlay.tsx',
]);

/** A JSX attribute giving an element the dialog role, in any quoting, not a `[role="dialog"]` selector. */
const DIALOG_ROLE = /(?<!\[)\brole=(?:"(?:alert)?dialog"|'(?:alert)?dialog'|\{\s*["'`](?:alert)?dialog["'`]\s*\})/;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(sourceRoot, [])) {
  const rel = path.relative(sourceRoot, file).split(path.sep).join('/');
  if (ALLOWED.has(rel)) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    if (DIALOG_ROLE.test(line)) violations.push(`src/${rel}:${index + 1}`);
  });
}

if (violations.length) {
  console.error('A dialog is rendered outside components/ui/Modal:');
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    '\nRender it with <Modal> instead. Pass `stacked` when it opens over another dialog and'
    + '\n`dismissible={!saving}` while a save is in flight. See scripts/check-dialog-shell.mjs.',
  );
  process.exit(1);
}
console.log('check-dialog-shell: every modal dialog uses components/ui/Modal.');
