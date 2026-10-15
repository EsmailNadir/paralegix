"use client";

import LinkifiedText from "@/components/ui/LinkifiedText";
import { eventZoneSuffix, formatEventWhen } from "@/components/calendarComp/calendarTiming";
import ZonedEventTime from "@/components/calendarComp/ZonedEventTime";

import { formatDateOnly } from '@/lib/utils/dateUtils';
import { useCallback, useEffect, useRef, useState } from 'react';
import usePagedRows from '@/hooks/usePagedRows';
import { useParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import clientPortalService, {
  PORTAL_DOCUMENTS_PER_UPLOAD,
  type PortalUploadFailure,
} from '@/services/client-portal.service';
import { UploadCancelledError } from '@/lib/files/resumableUpload';
import UploadProgressBar from '@/components/ui/UploadProgressBar';
import { UploadFailures } from '@/components/filesComp/UploadStatus';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorNotification from '@/components/ErrorNotification';
import ResourceNotFoundPage from '@/components/ui/ResourceNotFoundPage';
import BackButton from '@/components/ui/BackButton';
import { AutoPager } from '@/components/ui/ListPager';
import TruncatedListNotice from '@/components/ui/TruncatedListNotice';
import { UploadLimitNotice } from '@/components/ui/InlineWarning';
import RequestedDocumentsPanel from '@/components/portalComp/RequestedDocumentsPanel';
import FilePreviewModal, { type PreviewableFile } from '@/components/filesComp/FilePreviewModal';
import FilesService from '@/services/files.service';
import { Scale, Users, CalendarDays, DollarSign, MapPin, ChevronRight, FileText, Download, Upload } from 'lucide-react';
import { useNavigation } from '@/contexts/NavigationContext';
import NavigationLink from '@/components/ui/NavigationLink';
import { formatCurrency } from '@/lib/utils/currency';
import { formatBytes } from '@/lib/utils/format';
import MatterStatusBadge from '@/components/ui/MatterStatusBadge';
import StatusBadge from '@/components/ui/StatusBadge';
import { matterEventTypeMeta } from '@/constants/statusMeta';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import { useClientPortal } from '@/contexts/ClientPortalContext';
import ClientRecordPicker from '@/components/portalComp/ClientRecordPicker';
import Card from '@/components/ui/Card';
import SectionLabel from '@/components/ui/SectionLabel';

interface Matter {
  id: string;
  title: string;
  matterNumber?: string;
  status: string;
  matterType?: string;
  courtName?: string;
  opposingParty?: string;
  practiceAreaName?: string;
  description?: string;
  // The matter's pipeline stage (distinct from `status`), e.g. "Discovery".
  stageName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface MatterEvent {
  id: string;
  matterId: string;
  title?: string | null;
  type?: string | null;
  date?: string | null;
  allDay?: boolean;
  endsAt?: string | null;
  timeZone?: string | null;
  description?: string | null;
  location?: string | null;
}

interface PortalDocument {
  id: string;
  matterId?: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: string | null;
  downloadUrl: string;
  objectPath?: string | null;
}


// Files come back with `name` as the full path within the matter (e.g.
// "contracts/nda.pdf"); the basename is the last segment, the rest is the folder.
const docBaseName = (path: string) => {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
};
const docFolderPath = (path: string) => path.split('/').slice(0, -1).filter(Boolean).join(' / ');

export default function ClientMatterDetailPage() {
  const params = useParams();
  const { navigate } = useNavigation();
  const { user } = useAuth();
  const lawFirmId = params.lawFirmId as string;
  const matterId = params.matterId as string;
  const { associations, associationsLoading, activeAssociation, selectionRequired, setActiveClientRecordId } = useClientPortal();
  const clientRecordId = activeAssociation?.clientRecordId;

  const [matterData, setMatterData] = useState<Matter | null>(null);
  const [events, setEvents] = useState<MatterEvent[]>([]);
  const [eventsTruncated, setEventsTruncated] = useState(false);
  // Files shared with the client for this matter (incl. files inside shared folders).
  const [documents, setDocuments] = useState<PortalDocument[]>([]);
  // Both lists are capped server-side, so say when one came back short rather
  // than showing a partial list as if it were the whole thing.
  const [documentsTruncated, setDocumentsTruncated] = useState(false);
  const [openingDocId, setOpeningDocId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);
  // Id of the most recently clicked document's signed-url fetch; guards
  // against an older, slower fetch overwriting a newer one's preview.
  const openDocRequestRef = useRef<string | null>(null);
  // Client-initiated upload of a document into this matter.
  const [uploadingDoc, setUploadingDoc] = useState(false);
  // Every byte has landed and the server is filing; a cancel no longer stops it.
  const [docUploadFinalizing, setDocUploadFinalizing] = useState(false);
  const [docUploadFailures, setDocUploadFailures] = useState<PortalUploadFailure[]>([]);
  // How many files the last pick left out for going past the per-upload limit.
  const [docUploadLeftOut, setDocUploadLeftOut] = useState(0);
  const docUploadInputRef = useRef<HTMLInputElement | null>(null);
  // The upload in flight. Cleared on unmount, which is how a run that outlives
  // the page knows it has nothing left to update.
  const docUploadRef = useRef<AbortController | null>(null);
  // Leaving the page stops an upload that is still moving bytes, rather than
  // letting it finish unseen and file documents the client walked away from.
  // Past finalize the abort stops nothing: the server files what landed.
  useEffect(() => () => {
    docUploadRef.current?.abort();
    docUploadRef.current = null;
  }, []);
  // Outstanding balance + invoice count for this specific matter.
  const [matterBilling, setMatterBilling] = useState<{ outstanding: number; invoiceCount: number }>({
    outstanding: 0,
    invoiceCount: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const toDateOrNull = (value: unknown): Date | null => {
    if (value == null) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'string') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (typeof value === 'number') {
      const parsed = new Date(value > 1e12 ? value : value * 1000);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  };

  useEffect(() => {
    if (!lawFirmId || !matterId || !user || associationsLoading || selectionRequired) return;

    const fetchMatter = async () => {
      try {
        setLoading(true);
        setError(null);
        // The matter itself is required; events + billing only enrich the page, so
        // a failure in either must not block the matter from rendering.
        //
        // Every read here is asked for at matter scope. The firm-wide documents
        // and events reads are both capped, so narrowing them here would have let
        // this matter's rows fall outside a cap filled by other matters, and the
        // documents one scans the storage prefix of every matter the client is on
        // to build a list this page then throws most of away.
        const [matterRes, eventsRes, billingRes, docsRes] = await Promise.allSettled([
          clientPortalService.getMatter(lawFirmId, matterId, clientRecordId),
          clientPortalService.getEvents(lawFirmId, { matterId, clientRecordId }),
          clientPortalService.getBilling(lawFirmId, { clientRecordId }),
          clientPortalService.getMatterDocuments(lawFirmId, matterId, clientRecordId),
        ]);

        if (matterRes.status === 'fulfilled') {
          setMatterData(matterRes.value.matter);
        } else {
          throw matterRes.reason;
        }

        if (eventsRes.status === 'fulfilled') {
          setEvents(eventsRes.value.events || []);
          setEventsTruncated(!!eventsRes.value.truncated);
        }

        if (docsRes.status === 'fulfilled') {
          setDocuments(Array.isArray(docsRes.value?.documents) ? (docsRes.value.documents as PortalDocument[]) : []);
          setDocumentsTruncated(!!docsRes.value?.truncated);
        }

        if (billingRes.status === 'fulfilled') {
          const matterInvoices = (billingRes.value.invoices || []).filter((inv) => inv.matterId === matterId);
          const outstanding = matterInvoices.reduce((sum, inv) => {
            const remaining =
              typeof inv.remainingBalance === 'number'
                ? inv.remainingBalance
                : Math.max(0, (inv.totalAmount || 0) - (inv.amountPaid || 0) - (inv.totalWrittenOff || 0));
            return sum + Math.max(0, remaining);
          }, 0);
          setMatterBilling({ outstanding, invoiceCount: matterInvoices.length });
        }
      } catch (err) {
        console.error('Error fetching matter:', err);
        setError(getErrorMessage(err, 'Failed to load matter details'));
      } finally {
        setLoading(false);
      }
    };

    fetchMatter();
  }, [lawFirmId, matterId, user, associationsLoading, selectionRequired, clientRecordId]);


  const formatDate = (date: string | Date | null | undefined, includeTime = false) => {
    const d = toDateOrNull(date);
    if (!d) return 'N/A';

    try {
      const options: Intl.DateTimeFormatOptions = {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      };
      if (includeTime) {
        options.hour = '2-digit';
        options.minute = '2-digit';
      }
      return d.toLocaleDateString('en-US', options);
    } catch {
      return 'N/A';
    }
  };

  // Re-pull this matter's shared documents after an upload or request fulfillment.
  const refreshDocuments = useCallback(async () => {
    try {
      const docsRes = await clientPortalService.getMatterDocuments(lawFirmId, matterId, clientRecordId);
      setDocuments(Array.isArray(docsRes?.documents) ? (docsRes.documents as PortalDocument[]) : []);
      setDocumentsTruncated(!!docsRes?.truncated);
    } catch {
      // Non-fatal: the upload UI already surfaced any error it hit.
    }
  }, [lawFirmId, matterId, clientRecordId]);

  const handleUploadDocs = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    if (picked.length === 0) return;
    // The first files up to the limit are sent, and the rest are named in a
    // warning rather than refused along with the whole pick.
    const files = picked.slice(0, PORTAL_DOCUMENTS_PER_UPLOAD);
    setDocUploadLeftOut(picked.length - files.length);
    const controller = new AbortController();
    docUploadRef.current = controller;
    setUploadingDoc(true);
    setDocUploadFinalizing(false);
    setDocUploadFailures([]);
    setError(null);
    try {
      const result = await clientPortalService.uploadMatterDocuments(
        lawFirmId, matterId, files, undefined, clientRecordId,
        controller.signal, () => setDocUploadFinalizing(true),
      );
      if (docUploadRef.current !== controller) return;
      setDocUploadFailures(result.failures);
      await refreshDocuments();
    } catch (err) {
      if (docUploadRef.current !== controller) return;
      // A cancel is not a failure: the page simply goes back to how it was.
      if (!(err instanceof UploadCancelledError)) {
        setError(getErrorMessage(err, 'Failed to upload document'));
      }
    } finally {
      if (docUploadRef.current === controller) {
        docUploadRef.current = null;
        setUploadingDoc(false);
        setDocUploadFinalizing(false);
      }
    }
  };

  const handleOpenDoc = async (doc: PortalDocument) => {
    setOpeningDocId(doc.id);
    openDocRequestRef.current = doc.id;
    setError(null);
    try {
      let url = doc.downloadUrl;
      // Re-sign a fresh URL on open. The URL baked into the list expires (~30 min).
      if (doc.objectPath && doc.matterId) {
        const refreshed = await clientPortalService.refreshMatterDocumentUrl(lawFirmId, doc.matterId, doc.objectPath, clientRecordId);
        url = refreshed.downloadUrl;
      }
      if (!url) throw new Error('This document is no longer available.');
      // A newer click may have started a fetch for a different document while
      // this one was in flight; a slower response here would otherwise
      // silently replace whatever the user has since opened.
      if (openDocRequestRef.current !== doc.id) return;
      // Opens in the same in-app preview modal the firm side uses, rather than a
      // new browser tab.
      setPreviewFile({
        name: docBaseName(doc.name),
        size: doc.size,
        contentType: doc.type,
        signedUrl: url,
      });
    } catch (err) {
      if (openDocRequestRef.current === doc.id) {
        setError(getErrorMessage(err, 'Failed to open document'));
      }
    } finally {
      setOpeningDocId((current) => (current === doc.id ? null : current));
    }
  };

  // Each panel windows its own list. Declared above the early returns below so
  // the hooks run on every render.
  const documentsPager = usePagedRows(documents, 10);
  const eventsPager = usePagedRows(events, 5);

  if (selectionRequired) {
    return <ClientRecordPicker associations={associations} onSelect={setActiveClientRecordId} />;
  }

  if (loading) {
    return <LoadingSpinner fullPage />;
  }

  if (!matterData) {
    return (
      <ResourceNotFoundPage
        resourceLabel="matter"
        title="This matter is not available"
        description="The matter may no longer exist, or your client account may not have permission to open it."
        primaryAction={{
          label: "Return to my matters",
          onClick: () => navigate(`/client/lawfirm/${lawFirmId}/matters`),
        }}
        secondaryAction={{
          label: "Back to client dashboard",
          href: "/client/dashboard",
        }}
      />
    );
  }

  const updatedAt = toDateOrNull(matterData.updatedAt);

  return (
    <div className="p-8 max-w-[1600px] mx-auto min-w-0">
      {/* Back Button */}
      <BackButton href={`/client/lawfirm/${lawFirmId}/matters`} label="Back to Matters" variant="link" className="mb-6" />

      <ErrorNotification error={error} onClose={() => setError(null)} />

      {/* Header Card */}
      <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-6 mb-5">
        <div className="flex items-center gap-2 mb-2">
          <MatterStatusBadge status={matterData.status} />
          {matterData.stageName && (
            <span className="text-[10px] font-semibold text-on-surface-secondary bg-surface-alt px-2 py-0.5 rounded-md">
              {matterData.stageName}
            </span>
          )}
          {matterData.matterNumber && (
            <span className="font-mono text-[10px] text-on-surface-muted bg-surface-alt px-2 py-0.5 rounded-md">
              #{matterData.matterNumber}
            </span>
          )}
        </div>
        <h1 className="text-2xl font-bold text-on-surface">{matterData.title}</h1>
      </div>

      {/* Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left Column */}
        <div className="lg:col-span-2 space-y-5">
          {/* Matter Details */}
          <Card>
            <div className="px-5 py-3 border-b border-outline-subtle">
              <SectionLabel>Matter Details</SectionLabel>
            </div>
            <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="flex items-start gap-3">
                <div className="p-2 bg-accent-soft dark:bg-accent-soft text-accent-emphasis rounded-xl shrink-0">
                  <Scale className="w-4 h-4" />
                </div>
                <div>
                  <SectionLabel>Matter Type</SectionLabel>
                  <p className="text-sm font-medium text-on-surface mt-0.5">{matterData.matterType || 'Not specified'}</p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <div className="p-2 bg-accent-soft dark:bg-accent-soft text-accent-emphasis dark:text-accent-emphasis rounded-xl shrink-0">
                  <Users className="w-4 h-4" />
                </div>
                <div>
                  <SectionLabel>Opposing Party</SectionLabel>
                  <p className="text-sm font-medium text-on-surface mt-0.5">{matterData.opposingParty || 'None listed'}</p>
                </div>
              </div>

              {matterData.practiceAreaName && (
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-xl shrink-0">
                    <Scale className="w-4 h-4" />
                  </div>
                  <div>
                    <SectionLabel>Practice Area</SectionLabel>
                    <p className="text-sm font-medium text-on-surface mt-0.5">{matterData.practiceAreaName}</p>
                  </div>
                </div>
              )}

              {matterData.courtName && (
                <div className="flex items-start gap-3">
                  <div className="p-2 bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-xl shrink-0">
                    <Scale className="w-4 h-4" />
                  </div>
                  <div>
                    <SectionLabel>Court</SectionLabel>
                    <p className="text-sm font-medium text-on-surface mt-0.5">{matterData.courtName}</p>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* Description */}
          {matterData.description && (
            <Card>
              <div className="px-5 py-3 border-b border-outline-subtle">
                <SectionLabel>Description & Notes</SectionLabel>
              </div>
              <div className="p-5">
                <p className="text-sm text-on-surface-secondary leading-relaxed whitespace-pre-wrap">
                  {matterData.description}
                </p>
              </div>
            </Card>
          )}

          {/* Documents shared for this matter */}
          <Card>
            <div className="px-5 py-3 border-b border-outline-subtle flex items-center justify-between">
              <SectionLabel>Documents</SectionLabel>
              <div className="flex items-center gap-3">
                {documents.length > 0 && (
                  <NavigationLink
                    href={`/client/lawfirm/${lawFirmId}/documents?matter=${matterId}`}
                    aria-label="View all documents"
                    className="inline-flex items-center gap-0.5 text-[11px] font-medium text-accent-emphasis hover:text-accent-emphasis-hover dark:text-accent-emphasis dark:hover:text-accent-emphasis-hover"
                  >
                    View all <ChevronRight className="w-3 h-3" />
                  </NavigationLink>
                )}
                <button
                  onClick={() => docUploadInputRef.current?.click()}
                  disabled={uploadingDoc}
                  className="inline-flex items-center gap-1 rounded-lg bg-accent-solid text-accent-foreground text-[11px] font-medium px-2.5 py-1 hover:bg-accent-solid-hover transition-[background-color,border-color,color,transform] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed active:scale-[0.96] motion-reduce:active:scale-100"
                >
                  {uploadingDoc ? (
                    <>
                      <LoadingSpinner size="sm" />
                      Uploading
                    </>
                  ) : (
                    <>
                      <Upload className="w-3 h-3" /> Upload a document
                    </>
                  )}
                </button>
                <input
                  ref={docUploadInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleUploadDocs}
                />
              </div>
            </div>

            {uploadingDoc && (
              <div className="px-5 py-3 border-b border-outline-subtle">
                <UploadProgressBar
                  onCancel={docUploadFinalizing ? undefined : () => docUploadRef.current?.abort()}
                />
              </div>
            )}
            {docUploadLeftOut > 0 && (
              <div className="px-5 py-3 border-b border-outline-subtle">
                <UploadLimitNotice limit={PORTAL_DOCUMENTS_PER_UPLOAD} leftOut={docUploadLeftOut} />
              </div>
            )}
            {docUploadFailures.length > 0 && (
              <div className="px-5 py-3 border-b border-outline-subtle">
                <UploadFailures failures={docUploadFailures} />
              </div>
            )}

            {/* Documents the firm has requested from the client for this matter. */}
            <RequestedDocumentsPanel
              lawFirmId={lawFirmId}
              matterId={matterId}
              clientRecordId={clientRecordId}
              compact
              onFulfilled={refreshDocuments}
            />

            <TruncatedListNotice
              truncated={documentsTruncated}
              unitLabel="documents"
              mode="list"
              className="mx-5 mt-3"
            />

            {documents.length === 0 ? (
              <div className="p-5">
                <p className="text-xs text-on-surface-muted">No documents have been shared for this matter yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-outline-subtle">
                {documentsPager.pagedRows.map((doc) => {
                  const folder = docFolderPath(doc.name);
                  const isOpening = openingDocId === doc.id;
                  return (
                    <button
                      key={doc.id}
                      onClick={() => handleOpenDoc(doc)}
                      disabled={isOpening}
                      className="w-full text-left px-5 py-3 flex items-center gap-3 hover:bg-surface-hover transition-colors disabled:opacity-60"
                    >
                      <div className="p-2 rounded-xl bg-accent-soft dark:bg-accent-soft text-accent-emphasis flex-shrink-0">
                        <FileText className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-on-surface truncate">{docBaseName(doc.name)}</p>
                        <p className="text-[11px] text-on-surface-muted mt-0.5 truncate">
                          {folder ? `${folder} · ` : ''}{formatBytes(doc.size)}
                        </p>
                      </div>
                      <div className="flex-shrink-0 text-on-surface-muted">
                        {isOpening ? <LoadingSpinner size="sm" /> : <Download className="w-4 h-4" />}
                      </div>
                    </button>
                  );
                })}
                {documentsPager.total > documentsPager.rowsPerPage && (
                  <div className="px-5 py-3">
                    <AutoPager pager={documentsPager} />
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>

        {/* Right Column */}
        <div className="space-y-5">
          {/* Upcoming Events */}
          <Card>
            <div className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <CalendarDays className="w-4 h-4 text-accent-emphasis" />
                <p className="text-xs font-semibold text-on-surface">Upcoming Events</p>
              </div>

              <TruncatedListNotice
                truncated={eventsTruncated}
                unitLabel="events"
                mode="list"
                className="mb-3"
              />

              {events.length === 0 ? (
                <div className="flex items-center gap-2 text-on-surface-muted bg-surface-alt p-3 rounded-xl border border-dashed border-outline-subtle">
                  <span className="text-xs">No upcoming events scheduled.</span>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {eventsPager.pagedRows.map((ev) => (
                    <div key={ev.id} className="bg-surface-alt rounded-xl p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-semibold text-on-surface">{ev.title || ev.type || 'Event'}</p>
                        {ev.type && ev.title && (
                          <StatusBadge variant={matterEventTypeMeta(ev.type).variant}>
                            {matterEventTypeMeta(ev.type).label}
                          </StatusBadge>
                        )}
                      </div>
                      <p className="text-[11px] text-on-surface-secondary mt-1">
                        {/* An all-day event is its day alone: its date is only the day's noon-UTC anchor. */}
                        <ZonedEventTime
                          when={ev.endsAt
                            ? formatEventWhen({ id: ev.id, title: ev.title || '', start: ev.date || undefined, end: ev.endsAt, allDay: ev.allDay })
                            : ev.allDay
                              ? formatDateOnly(ev.date ? String(ev.date).slice(0, 10) : null, { year: 'numeric', month: 'long', day: 'numeric' }, 'N/A')
                              : formatDate(ev.date, true)}
                          zone={eventZoneSuffix({ start: ev.date, end: ev.endsAt, timeZone: ev.timeZone, allDay: ev.allDay })}
                        />
                      </p>
                      {ev.description && <p className="text-[11px] text-on-surface-muted mt-1"><LinkifiedText text={ev.description} /></p>}
                      {ev.location && (
                        <p className="flex items-center gap-1 text-[11px] text-on-surface-muted mt-1">
                          <MapPin className="w-3 h-3" /> <LinkifiedText text={ev.location} />
                        </p>
                      )}
                    </div>
                  ))}
                  {eventsPager.total > eventsPager.rowsPerPage && (
                    <AutoPager pager={eventsPager} />
                  )}
                </div>
              )}
            </div>
          </Card>

          {/* Billing Snapshot */}
          <Card>
            <div className="p-5">
              <div className="flex items-center gap-2 mb-3">
                <DollarSign className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <p className="text-xs font-semibold text-on-surface">Billing</p>
              </div>

              <div className="flex items-end justify-between">
                <div>
                  <SectionLabel>Outstanding</SectionLabel>
                  <p className={`text-xl font-bold mt-0.5 ${matterBilling.outstanding > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-on-surface'}`}>
                    {formatCurrency(matterBilling.outstanding)}
                  </p>
                </div>
                <p className="text-[11px] text-on-surface-muted">
                  {matterBilling.invoiceCount} invoice{matterBilling.invoiceCount !== 1 ? 's' : ''}
                </p>
              </div>

              {matterBilling.invoiceCount > 0 && (
                <NavigationLink
                  href={`/client/lawfirm/${lawFirmId}/billing`}
                  className="mt-3 w-full inline-flex items-center justify-center gap-1 rounded-xl bg-surface-alt hover:bg-surface-hover text-on-surface text-xs font-medium py-2 transition-[background-color,color,transform] duration-100 active:scale-[0.99] motion-reduce:active:scale-100 cursor-pointer"
                >
                  {matterBilling.outstanding > 0 ? 'View & pay invoices' : 'View invoices'}
                  <ChevronRight className="w-3.5 h-3.5" />
                </NavigationLink>
              )}
            </div>
          </Card>

          {/* Timeline */}
          <Card>
            <div className="px-5 py-3 border-b border-outline-subtle">
              <SectionLabel>Timeline</SectionLabel>
            </div>
            <div className="p-5 space-y-4">
              <div className="flex items-start gap-3 relative">
                <div className="absolute left-[9px] top-6 bottom-[-20px] w-px bg-outline-subtle last:hidden"></div>
                <div className="w-5 h-5 rounded-full bg-emerald-50 dark:bg-emerald-500/15 flex items-center justify-center shrink-0 z-10 mt-0.5">
                  <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                </div>
                <div>
                  <p className="text-[10px] text-on-surface-muted">Matter Created</p>
                  <p className="text-xs font-medium text-on-surface">{formatDate(matterData.createdAt)}</p>
                </div>
              </div>

              {updatedAt && (
                <div className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-accent-soft dark:bg-accent-soft flex items-center justify-center shrink-0 z-10 mt-0.5">
                    <div className="w-2 h-2 rounded-full bg-accent-selection"></div>
                  </div>
                  <div>
                    <p className="text-[10px] text-on-surface-muted">Last Updated</p>
                    <p className="text-xs font-medium text-on-surface">{formatDate(updatedAt)}</p>
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      <FilePreviewModal
        file={previewFile}
        isOpen={!!previewFile}
        onClose={() => { openDocRequestRef.current = null; setPreviewFile(null); }}
        onDownload={() => {
          if (previewFile?.signedUrl) {
            void FilesService.downloadFile(previewFile.signedUrl, previewFile.name);
          }
        }}
      />
    </div>
  );
}
