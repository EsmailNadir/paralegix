"use client";

import InlineWarning from "./InlineWarning";

/**
 * Inline warning shown when the server could not scan a whole file listing, so
 * what is on screen is a partial view.
 *
 * Every other "there is more" affordance in the app (a pager, a lookup's
 * "keep typing to narrow") implies the rest is one action away. This one does
 * not: the reader has to know the list itself is short, because a file browser
 * that quietly drops rows is how a firm concludes a document was never
 * uploaded. Renders `null` when the listing was complete, so callers can drop it
 * in unconditionally.
 */
export default function TruncatedListNotice({
  truncated,
  /** What the incomplete list holds, e.g. "files", "documents". */
  unitLabel = "files",
  /**
   * Which advice to give. Browsing has somewhere to go (a subfolder holds fewer
   * objects, so its own scan completes); a search does not, and the reader is
   * already treating the rows as "everything that matches", so it only gets the
   * warning. `list` is for a capped list that is not a file tree at all - an
   * agenda, a feed - where there is no narrower place to look, so it states the
   * shortfall and stops.
   *
   * `list` is CLIENT-FACING: it tells the reader to contact their legal team.
   * Use `firmList` for the same shape on a firm-facing screen, where the reader
   * is the legal team and that advice would be circular; it points at the filter
   * instead, which is the affordance those screens actually have.
   *
   * `selection` is the one case where the LIST on screen is complete and the
   * SELECTION over it is not: a "select all matching" that could only gather so
   * many ids. The reader is about to run a bulk action, so the warning has to be
   * about what that action will reach, not about what the list shows.
   */
  mode = "browse",
  className = "",
}: {
  truncated?: boolean;
  unitLabel?: string;
  mode?: "browse" | "search" | "list" | "firmList" | "selection";
  className?: string;
}) {
  if (!truncated) return null;

  const message = {
    browse: `There are more ${unitLabel} here than we could load at once, so this list is incomplete. Open a subfolder to see the rest.`,
    search: `There are more ${unitLabel} than we could scan, so some matches may be missing. Search inside a specific folder to narrow it down.`,
    list: `There are more ${unitLabel} than we could load at once, so this list is incomplete. Please contact your legal team if something you expect is missing.`,
    firmList: `There are more ${unitLabel} than we could load at once, so this list is incomplete. Filter to narrow it down.`,
    selection: `There are more matching ${unitLabel} than we could select at once, so bulk actions here apply only to the ${unitLabel} counted as selected. Filter to narrow it down.`,
  }[mode];

  return <InlineWarning className={className}>{message}</InlineWarning>;
}
