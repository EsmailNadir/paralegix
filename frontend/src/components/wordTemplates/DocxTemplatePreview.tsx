'use client'

// Read-only visual preview of a stored .docx template, rendered fully in the
// browser via docx-preview (OOXML → HTML/CSS). No server converter needed, so
// DOCX templates get a real preview even without the document converter. The
// {placeholders} appear inline in the rendered document, in their real position
// and formatting. Used in the editor's docx-setup pane in place of the old
// "Preview not available" placeholder.

import { useEffect, useRef, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import Spinner from '@/components/ui/Spinner'
import { wordTemplatesService } from '@/services/wordTemplates.service'

// A rendered Word page is paper: white in both themes, like the document itself.
const PAPER_STYLE = { background: '#ffffff' } as const

const SAFE_LINK_RE = /^(https?:|mailto:|tel:|#)/i
const SAFE_SOURCE_RE = /^(data:image\/|blob:)/i
const LINK_ATTRS = ['href', 'xlink:href'] as const

/**
 * docx-preview copies a document's hyperlink and image targets into the page
 * as they are, so an uploaded .docx could plant a `javascript:` link in the
 * app itself. Keep only web, mail, phone and in-document links, and only
 * images it embedded from the file; drop every other target.
 */
function neutralizeUnsafeTargets(host: HTMLElement) {
  host.querySelectorAll('*').forEach((el) => {
    for (const name of LINK_ATTRS) {
      const value = el.getAttribute(name)
      if (value !== null && !SAFE_LINK_RE.test(value.trim())) el.removeAttribute(name)
    }
    const src = el.getAttribute('src')
    if (src !== null && !SAFE_SOURCE_RE.test(src.trim())) el.removeAttribute('src')
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
    }
  })
}

export default function DocxTemplatePreview({ lawFirmId, templateId }: { lawFirmId: string; templateId: string }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host) return

    setStatus('loading')
    void (async () => {
      try {
        const source = await wordTemplatesService.docxSource(lawFirmId, templateId)
        if (cancelled) return

        // docx-preview is browser-only, import it lazily so it never touches SSR.
        const { renderAsync } = await import('docx-preview')
        if (cancelled) return // a newer effect run may have superseded this one
        host.replaceChildren()
        await renderAsync(source, host, undefined, {
          className: 'docx',
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          experimental: true,
        })
        neutralizeUnsafeTargets(host)
        if (!cancelled) setStatus('ready')
      } catch {
        if (!cancelled) setStatus('error')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [lawFirmId, templateId])

  return (
    <div className="relative h-full min-h-[800px] w-full max-w-[850px] overflow-auto rounded shadow-lg" style={PAPER_STYLE}>
      {/* docx-preview renders its own paginated pages + styles into this host. */}
      <div ref={hostRef} className={status === 'ready' ? '' : 'invisible'} />

      {status !== 'ready' && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface px-8 text-center text-on-surface-muted">
          {status === 'loading' ? (
            <>
              <Spinner size={20} />
              <span className="text-sm">Rendering preview…</span>
            </>
          ) : (
            <>
              <AlertCircle size={24} />
              <span className="text-sm font-medium text-on-surface">
                Couldn&apos;t render the preview
              </span>
              <span className="max-w-sm text-xs">
                The placeholder chips and re-upload above still work; download from the Fill
                flow to view the document in Word.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
