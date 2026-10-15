'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { FileUp } from 'lucide-react';

interface SignatureDropZoneProps {
  onFile: (file: File) => void;
  /** Accepted extensions, listed to the user while dragging. */
  extensions: string[];
  children: ReactNode;
}

/**
 * Makes the whole signing page a drop target, with an overlay that only appears
 * once a file is actually being dragged over it.
 *
 * The page used to reserve a large dashed panel for this at the top, which cost
 * the same space whether or not anyone ever dragged a file - and pushed the
 * firm's actual signing work below the fold. Dropping still works everywhere it
 * did; the invitation just waits until there is something to invite.
 */
export default function SignatureDropZone({ onFile, extensions, children }: SignatureDropZoneProps) {
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave fire again for every child element the cursor crosses, so
  // the nesting depth is what says whether the pointer has really left the page.
  const depthRef = useRef(0);

  const isFileDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer?.types || []).includes('Files');

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    depthRef.current += 1;
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setDragging(false);
  }, []);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    depthRef.current = 0;
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) onFile(file);
  }, [onFile]);

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={(event) => { if (isFileDrag(event)) event.preventDefault(); }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative"
    >
      {children}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent-control-ring bg-page/85 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent-emphasis">
              <FileUp size={26} />
            </span>
            <p className="text-base font-semibold text-on-surface">Drop to start signing</p>
            <p className="text-xs text-on-surface-muted">
              {extensions.map((ext) => ext.replace('.', '').toUpperCase()).join(' · ')}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
