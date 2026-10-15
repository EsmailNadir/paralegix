"use client";

/**
 * Empty filler cards that pad a partial page of billing report rows up to a full
 * page, so the by-client and by-matter lists keep a constant height instead of
 * shrinking on the last page or a narrow filter.
 *
 * The filler mirrors the real card's markup rather than hardcoding a pixel
 * height. The cards reflow at every breakpoint (the header stacks under `md`,
 * the stat footer collapses under `sm`), so a fixed height would only ever be
 * right at one viewport width. Reproducing the structure with blank text keeps
 * the reserved space exactly a card tall at any width.
 */
export default function BillingReportCardFiller({ count }: { count: number }) {
  if (count <= 0) return null;

  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={`filler-${index}`}
          aria-hidden="true"
          className="invisible select-none rounded-lg border border-transparent p-4 max-sm:p-5"
        >
          <div className="flex flex-col gap-3 max-sm:gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0 flex-1">
              <div className="mb-1 max-sm:mb-2 flex flex-wrap items-center gap-2">
                <span className="text-lg font-semibold">&nbsp;</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                &nbsp;
              </div>
              <p className="mt-2 max-sm:mt-3 text-sm">&nbsp;</p>
              {/* Real cards always reserve a next-payment line, so the filler
                  carries one too. */}
              <p className="mt-2 max-sm:mt-3 text-sm font-medium">&nbsp;</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-lg font-semibold tabular-nums">&nbsp;</p>
              <p className="text-sm tabular-nums">&nbsp;</p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 border-t border-transparent pt-4 text-sm sm:grid-cols-4">
            {Array.from({ length: 4 }).map((__, statIndex) => (
              <div key={statIndex}>
                <p className="text-xs uppercase tracking-wide">&nbsp;</p>
                <p className="mt-1 font-medium">&nbsp;</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
