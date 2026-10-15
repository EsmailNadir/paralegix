'use client';

import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

/** Expose embedded text from every PDF page without changing the document layout. */
export default function SigningDocumentText({ pdf }: { pdf: PDFDocumentProxy | null }) {
  const [content, setContent] = useState<{ pdf: PDFDocumentProxy; pages: string[][]; error: boolean } | null>(null);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    const read = async () => {
      try {
        const pages: string[][] = [];
        for (let number = 1; number <= pdf.numPages; number += 1) {
          if (cancelled) return;
          const page = await pdf.getPage(number);
          const text = await page.getTextContent();
          const lines: string[] = [];
          let line = '';
          for (const item of text.items) {
            if (!('str' in item)) continue;
            line += `${item.str} `;
            if (item.hasEOL) { lines.push(line.trim()); line = ''; }
          }
          if (line.trim()) lines.push(line.trim());
          pages.push(lines.filter(Boolean));
        }
        if (!cancelled) setContent({ pdf, pages, error: false });
      } catch {
        if (!cancelled) setContent({ pdf, pages: [], error: true });
      }
    };
    void read();
    return () => { cancelled = true; };
  }, [pdf]);

  const current = content?.pdf === pdf ? content : null;
  return (
    <section className="sr-only" aria-label="Document text">
      <p>The PDF&apos;s embedded text follows. Layout, images, and handwritten content may be missing. If any content is missing or unclear, ask the sender for an accessible copy before signing.</p>
      <div role="status">{!current ? 'Reading document text...' : current.error ? 'Unable to read document text. Ask the sender for an accessible copy before signing.' : `${current.pages.length} pages read.`}</div>
      {current?.pages.map((lines, index) => (
        <section key={index} aria-label={`Page ${index + 1}`}>
          <h3>Page {index + 1}</h3>
          {lines.length === 0 ? <p>No embedded text on this page. Ask the sender for an accessible copy before signing.</p> : lines.map((line, number) => <p key={number}>{line}</p>)}
        </section>
      ))}
    </section>
  );
}
