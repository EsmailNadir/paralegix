// Lightweight placeholder shown while the heavy (~8.6k LOC) TemplateEditor
// chunk loads. Keeps the route interactive-looking instead of blank while the
// editor's JavaScript downloads and parses.
export function TemplateEditorSkeleton() {
  return (
    <div className="animate-pulse p-6" aria-hidden="true">
      <div className="mb-6 flex items-center justify-between">
        <div className="h-8 w-48 rounded bg-surface-hover" />
        <div className="flex gap-2">
          <div className="h-8 w-24 rounded-lg bg-surface-hover" />
          <div className="h-8 w-24 rounded-lg bg-surface-hover" />
        </div>
      </div>
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="h-4 w-3/4 rounded bg-surface-hover" />
        <div className="h-4 w-full rounded bg-surface-hover" />
        <div className="h-4 w-5/6 rounded bg-surface-hover" />
        <div className="h-64 w-full rounded bg-surface-hover" />
        <div className="h-4 w-2/3 rounded bg-surface-hover" />
      </div>
    </div>
  )
}
