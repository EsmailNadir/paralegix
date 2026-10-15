'use client';

import { useState } from 'react';
import { ArrowRight, CheckCircle2, Hand, RotateCcw } from 'lucide-react';
import RestrictedSigningView from './RestrictedSigningView';
import type { SignatureField } from '@/types/signature';

interface InPersonSigningFlowProps {
  file: { url: string; name: string; bytes?: Uint8Array };
  fields: SignatureField[];
  token: string;
  sourceRevision?: string | null;
  signerName?: string | null;
  signerRole?: string | null;
}

type Stage = 'handoff' | 'signing' | 'return' | 'complete';

export default function InPersonSigningFlow({
  file,
  fields,
  token,
  sourceRevision,
  signerName,
  signerRole,
}: InPersonSigningFlowProps) {
  const [stage, setStage] = useState<Stage>('handoff');
  const [nextSignerName, setNextSignerName] = useState<string | null>(null);

  const currentLabel = signerName || signerRole || 'the signer';

  if (stage === 'handoff') {
    return (
      <div className="flex-1 flex items-center justify-center p-6 bg-page">
        <div className="max-w-lg w-full rounded-3xl border border-outline-subtle bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8 text-center space-y-5">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300">
            <Hand className="h-8 w-8" />
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-on-surface-muted">In-Person Signing</p>
            <h1 className="text-2xl font-bold text-on-surface">Hand the device to {currentLabel}</h1>
            <p className="text-sm leading-relaxed text-on-surface-secondary">
              When they are ready, continue to the signing screen. Their session is kept on this device and will return to staff after submission.
            </p>
          </div>
          <button
            onClick={() => setStage('signing')}
            className="inline-flex items-center gap-2 rounded-xl bg-amber-500 px-5 py-3 text-sm font-semibold text-white hover:bg-amber-600 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            Ready to Sign
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  if (stage === 'return') {
    return (
      <div className="flex-1 flex items-center justify-center p-6 bg-page">
        <div className="max-w-lg w-full rounded-3xl border border-outline-subtle bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8 text-center space-y-5">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-accent-emphasis dark:bg-blue-900/30 dark:text-blue-300">
            <RotateCcw className="h-8 w-8" />
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-on-surface-muted">Return Device</p>
            <h2 className="text-2xl font-bold text-on-surface">Return the device to staff</h2>
            <p className="text-sm leading-relaxed text-on-surface-secondary">
              {nextSignerName
                ? `${nextSignerName} is the next signer. Continue when the next person is present and ready.`
                : 'This signer has finished. Continue when the next signer is ready.'}
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 rounded-xl bg-accent-solid px-5 py-3 text-sm font-semibold text-accent-foreground hover:bg-accent-solid-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
          >
            Continue to Next Signer
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  if (stage === 'complete') {
    return (
      <div className="flex-1 flex items-center justify-center p-6 bg-page">
        <div className="max-w-lg w-full rounded-3xl border border-outline-subtle bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-8 text-center space-y-5">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-300">
            <CheckCircle2 className="h-8 w-8" />
          </div>
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-on-surface-muted">All Done</p>
            <h2 className="text-2xl font-bold text-on-surface">In-person signing is complete</h2>
            <p className="text-sm leading-relaxed text-on-surface-secondary">
              The document has been finalized and returned to the firm.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <RestrictedSigningView
      file={file}
      fields={fields}
      token={token}
      sourceRevision={sourceRevision}
      instructionText="Complete each field with the signer, then submit the document to return the device to staff."
      showCompletionScreen={false}
      onSubmitted={(result) => {
        setNextSignerName(result.nextSignerName || null);
        setStage(result.waitingForNextSigner ? 'return' : 'complete');
      }}
    />
  );
}
