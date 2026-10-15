#!/usr/bin/env bash
# Grep pass for the Paralegix frontend consistency rules.
#
# Run it by its full path from the repo root; a bare `scripts/check-ui.sh`
# resolves to the repo's own scripts/ directory instead.
#
#   .claude/skills/paralegix-frontend/scripts/check-ui.sh                  # files changed vs the branch point
#   .claude/skills/paralegix-frontend/scripts/check-ui.sh path/to/File.tsx # specific files
#   .claude/skills/paralegix-frontend/scripts/check-ui.sh --all            # the whole frontend (expect existing drift)
#
# Exits 1 if anything is flagged. Every check is a heuristic: read the hit before
# acting on it. Editing a file that already contains drift does not oblige you to
# fix it — see references/known-drift.md.

# Deliberately not `set -u`: macOS ships bash 3.2, where an empty array expansion
# under `set -u` is an error rather than nothing.
set -o pipefail

cd "$(git rev-parse --show-toplevel)" || exit 1
FRONTEND="frontend/src"
found=0

# bash 3.2 has no `mapfile`, and repo paths contain `[lawFirmId]` (glob characters),
# so the list is read line by line into a quoted array rather than word-split. The
# reads use process substitution, not a pipe: the last stage of a pipeline runs in
# a subshell, so anything appended to FILES there would be lost.
FILES=()
collect() { while IFS= read -r line; do [ -f "$line" ] && FILES+=("$line"); done; }

if [ "${1:-}" = "--all" ]; then
  collect < <(find "$FRONTEND" \( -name '*.tsx' -o -name '*.ts' \))
elif [ $# -gt 0 ]; then
  for f in "$@"; do [ -f "$f" ] && FILES+=("$f"); done
else
  collect < <(git diff --name-only HEAD -- "$FRONTEND" | grep -E '\.tsx?$')
  if [ ${#FILES[@]} -eq 0 ]; then
    collect < <(git diff --name-only origin/staging...HEAD -- "$FRONTEND" | grep -E '\.tsx?$')
  fi
fi

if [ ${#FILES[@]} -eq 0 ]; then
  echo "check-ui: no frontend files to check."
  exit 0
fi

echo "check-ui: ${#FILES[@]} file(s)"
echo

report() { # <title> <fix>
  echo "── $1"
  echo "   fix: $2"
  found=1
}

hits() { grep -nE "$1" "${FILES[@]}" 2>/dev/null; }

# 1. A dialog without the accessibility plumbing.
for f in "${FILES[@]}"; do
  case "$f" in *.tsx) ;; *) continue ;; esac
  if grep -q 'fixed inset-0 z-' "$f" && grep -q 'useMountTransition' "$f"; then
    grep -q 'menuAnim' "$f" && continue                      # a popover, not a dialog
    if ! grep -q 'useDialog' "$f"; then
      report "modal without useDialog: $f" \
             "add useDialog + role=\"dialog\" aria-modal aria-labelledby (see AddExpenseModal.tsx)"
    fi
  fi
done

# 2. Hand-rolled spinner.
out=$(hits 'animate-spin' | grep -vE 'ui/Spinner|LoadingSpinner')
[ -n "$out" ] && { report "hand-rolled spinner" "use <Spinner> or <LoadingSpinner>"; echo "$out" | sed 's/^/   /'; }

# 3. Non-token colours.
out=$(hits '(text|bg|border)-(gray|slate|neutral|zinc|stone)-[0-9]')
[ -n "$out" ] && { report "gray-scale literal (breaks dark mode)" "use bg-surface / text-on-surface / border-outline tokens"; echo "$out" | sed 's/^/   /'; }

out=$(hits '\b(bg-white|text-black)\b' | grep -v 'dark:' | grep -v 'mkt-')
[ -n "$out" ] && { report "bg-white / text-black literal" "use bg-surface / text-on-surface"; echo "$out" | sed 's/^/   /'; }

out=$(hits 'bg-blue-600')
[ -n "$out" ] && { report "bg-blue-600" "use the bg-accent-solid token, not a raw Tailwind blue"; echo "$out" | sed 's/^/   /'; }

# 4. Local colour/status maps. `statusMeta.ts` is the one place these belong, so
# its own records are not hits.
out=$(hits 'Record<[^>]*>\s*=\s*\{' | grep -iE 'color|status|badge|variant|priority|style' | grep -v 'constants/statusMeta')
[ -n "$out" ] && { report "local colour/status map" "move it to @/constants/statusMeta"; echo "$out" | sed 's/^/   /'; }

# 5. Hand-rolled pill.
out=$(hits 'rounded-full' | grep -E 'px-[0-9]' | grep -E 'text-(xs|sm|\[9px\]|\[10px\]|\[11px\])' | grep -v 'components/ui/')
[ -n "$out" ] && { report "hand-rolled pill" "use <StatusBadge> or a per-domain badge"; echo "$out" | sed 's/^/   /'; }

# 6. Native tooltip.
out=$(grep -nE -B2 'title="' "${FILES[@]}" 2>/dev/null | grep -E '<(button|div|span|a|td|th|li|img)\b')
[ -n "$out" ] && { report "possible native title= tooltip" "use <Tooltip title=… enterDelay={300}> from @/components/ui/Tooltip"; echo "$out" | sed 's/^/   /'; }

# 7. Navigation.
out=$(hits 'router\.(push|replace)\(' | grep -vE 'marketingComp|app/admin/|app/login|app/register|app/logout|auth/|accept-|reset-password|verify-email|layout\.tsx|Sidebar|LegalPage|StatusPage')
[ -n "$out" ] && { report "router.push/replace in feature code" "use navigate() from useNavigation()"; echo "$out" | sed 's/^/   /'; }

out=$(hits "from ['\"]next/link")
[ -n "$out" ] && { report "next/link import" "use navigate() from useNavigation() for in-app links"; echo "$out" | sed 's/^/   /'; }

# 8. Hand-rolled empty state.
#
# Matching on "No X yet" alone is useless: most hits are one-line notes inside a
# settings card, where a py-16 dashed card would be a layout change rather than a
# fix. So this looks for the shape ListEmptyState actually owns — a dashed,
# centred card — and skips drop zones, which share the dashed border but are not
# empty states.
for f in "${FILES[@]}"; do
  case "$f" in *.tsx) ;; *) continue ;; esac
  grep -q 'ListEmptyState' "$f" && continue
  grep -qE 'isDragging|onDrop|handleDrop|uploading' "$f" && continue   # drop zone
  if grep -E 'border-dashed' "$f" | grep -q 'text-center'; then
    report "possible hand-rolled empty state: $f" \
           "if it stands in for an empty list, use <ListEmptyState>; an inline one-liner is fine as-is"
  fi
done

# 9. Heroicons / emoji icons.
out=$(hits '@heroicons')
[ -n "$out" ] && { report "Heroicons import" "this repo uses lucide-react"; echo "$out" | sed 's/^/   /'; }

# 10. Fixed height on a form control.
out=$(hits 'className="[^"]*\bh-1[01]\b[^"]*"' | grep -iE 'input|select|dropdown|filter')
[ -n "$out" ] && { report "fixed height on a form control" "let px-3 py-2 set the height so it matches Dropdown"; echo "$out" | sed 's/^/   /'; }

# 11. Z-index escalation.
out=$(hits 'z-\[(7[0-9]|[89][0-9]|[0-9]{3,})')
[ -n "$out" ] && { report "z-index above the z-[60] ladder" "z-50 modals, z-[60] modal-over-modal; higher means the nesting is wrong"; echo "$out" | sed 's/^/   /'; }

echo
if [ "$found" -eq 0 ]; then
  echo "check-ui: clean"
else
  echo "check-ui: review the hits above. Pre-existing drift in a file you were already"
  echo "          editing is not yours to fix — see references/known-drift.md."
fi
exit "$found"
