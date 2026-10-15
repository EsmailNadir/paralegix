"use client";

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import signaturesService from '@/services/signatures.service';
import ErrorNotification from '@/components/ErrorNotification';
import ListPager from '@/components/ui/ListPager';
import ListSkeleton from '@/components/ui/ListSkeleton';
import ListEmptyState from '@/components/ui/ListEmptyState';
import { PenLine, FileText, CheckCircle2, Clock } from 'lucide-react';
import NavigationLink from '@/components/ui/NavigationLink';
import { useClientSigningRealtime } from '@/hooks/useSigningRealtime';
import { toLocalDate } from '@/lib/utils/dateUtils';
import { getErrorMessage } from '@/lib/utils/apiErrors';

interface PendingDocument {
  sessionToken: string;
  lawFirmId: string;
  fileName: string;
  routingMode: string;
  createdAt: string | null;
  participantId: string;
  participantRole: string;
  participantName: string | null;
  publicToken: string | null;
  totalParticipants: number;
  completedParticipants: number;
}

const formatDate = (value: string | null) => {
  const d = toLocalDate(value);
  if (!d) return null;
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
};

const PAGE_SIZE = 15;

export default function ClientSignaturesPage() {
  const params = useParams();
  const { user } = useAuth();
  const lawFirmId = params.lawFirmId as string;

  const [pending, setPending] = useState<PendingDocument[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  // A page change keeps the cards on screen and marks the pager busy, rather than
  // collapsing the list back to the initial-load skeleton.
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));

  // Both the firm scope and the window are the server's: a client who signs for
  // several firms can have more waiting documents than one page holds, and
  // narrowing a page of them here would drop whichever fell outside it.
  const loadPage = useCallback(async (nextPage: number) => {
    const response = await signaturesService.getPendingForClient({
      lawFirmId,
      limit: PAGE_SIZE,
      offset: (nextPage - 1) * PAGE_SIZE,
    });
    setPending(response.pendingDocuments || []);
    setTotalItems(response.totalItems || 0);
  }, [lawFirmId]);

  const load = useCallback(async () => {
    try {
      setError(null);
      await loadPage(1);
      setPage(1);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load your documents'));
      setPending([]);
      setTotalItems(0);
    } finally {
      setLoading(false);
    }
  }, [loadPage]);

  useEffect(() => {
    if (!user) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: pending documents/loading/error state set as the request progresses
    load();
  }, [user, load]);

  // Refresh the list live when this client's signing participant rows change.
  useClientSigningRealtime(user?.uid, load);

  const goToPage = async (nextPage: number) => {
    const clamped = Math.min(Math.max(1, nextPage), totalPages);
    if (fetching || clamped === page) return;
    try {
      setFetching(true);
      await loadPage(clamped);
      setPage(clamped);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to load your documents'));
    } finally {
      setFetching(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 max-w-[1600px] mx-auto min-w-0">
        <ListSkeleton rows={5} label="Loading documents to sign" />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1600px] mx-auto min-w-0">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-accent-solid rounded-xl flex items-center justify-center">
            <PenLine className="w-5 h-5 text-accent-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-on-surface">Documents to Sign</h1>
            <p className="text-sm text-on-surface-muted">Review and sign documents your legal team has sent you.</p>
          </div>
        </div>
      </div>

      <ErrorNotification error={error} onClose={() => setError(null)} />

      {pending.length === 0 ? (
        <ListEmptyState
          icon={<CheckCircle2 className="w-8 h-8 text-emerald-500" />}
          title="You're all caught up"
          message="There are no documents waiting for your signature right now."
        />
      ) : (
        <div className="space-y-3">
          {pending.map((doc) => {
            const sent = formatDate(doc.createdAt);
            const multiParty = doc.totalParticipants > 1;
            return (
              <div
                key={doc.sessionToken}
                className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div className="p-2.5 rounded-xl bg-accent-soft dark:bg-accent-soft text-accent-emphasis dark:text-accent-emphasis shrink-0">
                    <FileText className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-on-surface truncate">{doc.fileName}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                      {sent && (
                        <span className="inline-flex items-center gap-1 text-[11px] text-on-surface-muted">
                          <Clock className="w-3 h-3" /> Sent {sent}
                        </span>
                      )}
                      {multiParty && (
                        <span className="text-[11px] text-on-surface-muted">
                          {doc.completedParticipants} of {doc.totalParticipants} signers complete
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <NavigationLink
                  href={`/signature?token=${encodeURIComponent(doc.publicToken || doc.sessionToken)}`}
                  aria-label={`Review and sign ${doc.fileName}`}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent-solid px-4 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-solid-hover transition-[background-color,border-color,color,transform] cursor-pointer shrink-0 active:scale-[0.96] motion-reduce:active:scale-100"
                >
                  <PenLine className="w-4 h-4" />
                  Review &amp; Sign
                </NavigationLink>
              </div>
            );
          })}
          {totalItems > PAGE_SIZE && (
            <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] px-5 py-3">
              <ListPager
                page={page}
                totalPages={totalPages}
                total={totalItems}
                rowsPerPage={PAGE_SIZE}
                onPageChange={goToPage}
                busy={fetching}
                serverPaged
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
