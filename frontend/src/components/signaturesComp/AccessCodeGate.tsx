'use client';

import { useState, useEffect, useId, useRef, useCallback } from 'react';
import { FileText, Lock, AlertCircle } from 'lucide-react';
import signaturesService from '@/services/signatures.service';
import Spinner from '@/components/ui/Spinner';
import { getErrorMessage } from '@/lib/utils/apiErrors';

interface AccessCodeGateProps {
  token: string;
  // The file name is intentionally withheld by the backend until the access code
  // is verified, so it may be empty here. The file row is hidden when it is.
  fileName?: string;
  onVerified: () => void;
}

export default function AccessCodeGate({ token, fileName, onVerified }: AccessCodeGateProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lockedSeconds, setLockedSeconds] = useState(0);
  const [verifying, setVerifying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const errorId = useId();
  const [invalidCode, setInvalidCode] = useState(false);
  const wasLocked = useRef(false);
  const isLocked = lockedSeconds > 0;

  useEffect(() => {
    if (error && !verifying) {
      if (invalidCode && !isLocked) inputRef.current?.focus();
      else errorRef.current?.focus();
    }
  }, [error, verifying, invalidCode, isLocked]);
  useEffect(() => {
    if (wasLocked.current && !isLocked) inputRef.current?.focus();
    wasLocked.current = isLocked;
  }, [isLocked]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Lockout countdown timer
  useEffect(() => {
    if (lockedSeconds <= 0) return;
    const timer = setInterval(() => {
      setLockedSeconds((prev) => {
        const next = prev - 1;
        if (next <= 0) setError(null);
        return Math.max(0, next);
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [lockedSeconds]);

  const handleVerify = useCallback(async () => {
    if (!code.trim() || verifying || lockedSeconds > 0) return;
    setVerifying(true);
    setError(null);
    setInvalidCode(false);
    try {
      const result = await signaturesService.verifyAccessCode(token, code.trim());
      if (result.verified) {
        onVerified();
        return;
      }
      if (result.lockedSeconds) {
        setLockedSeconds(result.lockedSeconds);
        setError(`Too many failed attempts. Please wait ${result.lockedSeconds} seconds.`);
        setCode('');
        return;
      }
      setError(
        result.attemptsRemaining !== undefined
          ? `Incorrect access code. ${result.attemptsRemaining} attempt${result.attemptsRemaining !== 1 ? 's' : ''} remaining.`
          : (result.error || 'Incorrect access code')
      );
      if (result.attemptsRemaining !== undefined) {
        setInvalidCode(true);
        setCode('');
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Verification failed'));
    } finally {
      setVerifying(false);
    }
  }, [token, code, verifying, onVerified, lockedSeconds]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleVerify();
  };

  return (
    <div className="min-h-screen bg-page flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-surface rounded-2xl shadow-lg overflow-hidden">
          {/* Header */}
          <div className="h-1 bg-gradient-to-r from-accent-solid to-accent-solid-hover" />
          <div className="px-8 pt-8 pb-2 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-accent-soft mb-4">
              <Lock size={28} className="text-accent-emphasis" />
            </div>
            <h1 className="text-xl font-bold text-on-surface mb-1">Access code required</h1>
            {fileName ? (
              <div className="flex items-center justify-center gap-2 text-sm text-on-surface-muted mb-4">
                <FileText size={14} />
                <span className="truncate max-w-[250px]">{fileName}</span>
              </div>
            ) : (
              <div className="mb-4" />
            )}
          </div>

          {/* Body */}
          <div className="px-8 pb-8">
            <p className="text-sm text-center text-on-surface-secondary mb-6">
              Enter the access code provided by the sender to view this document.
            </p>

            {/* Access code input */}
            <input
              ref={inputRef}
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={verifying || isLocked}
              placeholder="Enter access code"
              aria-label="Access code"
              aria-invalid={invalidCode || undefined}
              aria-describedby={error ? errorId : undefined}
              className="w-full px-4 py-3 text-center text-lg font-medium rounded-lg border-2 border-input-border bg-input-bg text-on-surface focus-visible:ring-2 focus-visible:ring-focus-ring focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-on-surface-muted mb-4"
              autoComplete="off"
            />

            {/* Verify button */}
            <button
              onClick={handleVerify}
              disabled={!code.trim() || verifying || isLocked}
              className="w-full py-3 px-4 text-sm font-semibold rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.985] motion-reduce:active:scale-100 flex items-center justify-center gap-2 cursor-pointer mb-4"
            >
              {verifying && <Spinner size={16} />}
              {verifying ? 'Verifying...' : 'Verify'}
            </button>

            <span role="status" aria-live="polite" className="sr-only">
              {verifying ? 'Verifying access code' : ''}
            </span>

            {/* Error */}
            {error && (
              <div
                ref={errorRef}
                id={errorId}
                tabIndex={-1}
                role="alert"
                className="flex items-start gap-2 p-3 mb-4 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-sm"
              >
                <AlertCircle size={16} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Lockout timer */}
            {isLocked && (
              <p className="text-center text-sm text-on-surface-muted">
                Try again in <span className="font-medium">{lockedSeconds}s</span>
              </p>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-on-surface-muted mt-4">
          This access code protects the document from unauthorized access.
        </p>
      </div>
    </div>
  );
}
