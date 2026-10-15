'use client';

import { PenLine, Upload } from 'lucide-react';
import UploadStatusChip from '@/components/ui/UploadStatusChip';

interface SignatureSendPanelProps {
  onClick: () => void;
  onCancel?: () => void;
  uploading: boolean;
  /** Accepted extensions, spelled out so the formats are known before choosing. */
  extensions: string[];
}

/**
 * Sending a document for signature, as the page's primary target.
 *
 * This is what people open the signing page to do, so it gets the top of the page
 * and enough size to be the obvious next click rather than a button in the header
 * competing with the page title. The whole panel is the target · the button inside
 * it is styling, not a second control - and it takes a dropped file as readily as
 * a click.
 */
export default function SignatureSendPanel({
  onClick,
  onCancel,
  uploading,
  extensions,
}: SignatureSendPanelProps) {
  const activate = () => { if (!uploading) onClick(); };

  return (
    <div
      role="button"
      tabIndex={uploading ? -1 : 0}
      aria-label="Send a document for signature"
      aria-busy={uploading}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      }}
      className={`group flex flex-col gap-5 rounded-2xl border-2 border-dashed p-5 transition-colors sm:flex-row sm:items-center sm:justify-between sm:p-7 ${
        uploading
          ? 'cursor-default border-accent-border-soft bg-accent-soft'
          : 'cursor-pointer border-accent-border-soft bg-accent-soft hover:border-accent-solid/60 hover:bg-accent-soft'
      }`}
    >
      <div className="flex items-center gap-4 sm:gap-5">
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-emphasis transition-transform group-hover:scale-105 motion-reduce:transition-none sm:size-14">
          <PenLine className="size-6 sm:size-7" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-on-surface sm:text-lg">
            Send a document for signature
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-on-surface-secondary sm:text-sm">
            Sign it yourself or send it to clients and colleagues. Drop a file anywhere on this page.
          </p>
          <p className="mt-1.5 text-[11px] uppercase tracking-wider text-on-surface-muted">
            {extensions.map((ext) => ext.replace('.', '')).join(' · ')}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-stretch gap-1.5 sm:items-end">
        {uploading ? (
          <UploadStatusChip onCancel={onCancel} />
        ) : (
          <>
            <span className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent-solid px-5 py-3 text-sm font-semibold text-accent-foreground shadow-sm transition-colors group-hover:bg-accent-solid-hover dark:shadow-none">
              <Upload size={17} strokeWidth={2.2} />
              Choose a file
            </span>
            <span className="text-center text-[11px] text-on-surface-muted sm:text-right">
              or drag one in
            </span>
          </>
        )}
      </div>
    </div>
  );
}
