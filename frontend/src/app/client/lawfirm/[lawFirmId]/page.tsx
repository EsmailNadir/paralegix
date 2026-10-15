"use client";

import { useParams } from 'next/navigation';
import { useState, useEffect } from 'react';
import lawfirmService from '@/services/lawfirm.service';
import clientPortalService from '@/services/client-portal.service';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorNotification from '@/components/ErrorNotification';
import ResourceNotFoundPage from '@/components/ui/ResourceNotFoundPage';
import { AutoPager } from '@/components/ui/ListPager';
import ListEmptyState from '@/components/ui/ListEmptyState';
import usePagedRows from '@/hooks/usePagedRows';
import type { LawFirm, Matter } from '@/types';
import { Building2, FileText, ChevronRight, MessageSquare } from 'lucide-react';
import NavigationLink from '@/components/ui/NavigationLink';
import MatterStatusBadge from '@/components/ui/MatterStatusBadge';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import { useClientPortal } from '@/contexts/ClientPortalContext';
import ClientRecordPicker from '@/components/portalComp/ClientRecordPicker';
import SectionLabel from '@/components/ui/SectionLabel';
import IdentityVerificationCard from '@/components/portalComp/IdentityVerificationCard';

export default function ClientLawFirmPage() {
  const params = useParams();
  const lawFirmId = params.lawFirmId as string;
  const { associations, associationsLoading, activeAssociation, selectionRequired, setActiveClientRecordId } = useClientPortal();
  const clientRecordId = activeAssociation?.clientRecordId;

  const [lawFirm, setLawFirm] = useState<LawFirm | null>(null);
  const [matters, setMatters] = useState<Matter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!lawFirmId || associationsLoading || selectionRequired) return;

    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        const [firmData, mattersResponse] = await Promise.all([
          lawfirmService.getLawFirmById(lawFirmId),
          clientPortalService.getMatters(lawFirmId, clientRecordId),
        ]);

        setLawFirm(firmData);
        const mappedMatters: Matter[] = Array.isArray(mattersResponse?.matters)
          ? mattersResponse.matters.map(clientMatter => ({
              ...clientMatter,
              name: (clientMatter as any).title || clientMatter.id,
            })) as Matter[]
          : [];
        setMatters(mappedMatters);
      } catch (err) {
        const msg = getErrorMessage(err, 'Failed to load data');
        if (!msg.toLowerCase().includes('not associated')) {
          setError(msg);
        }
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [lawFirmId, associationsLoading, selectionRequired, clientRecordId]);

  // Declared above the early returns below so the hook runs on every render.
  const mattersPager = usePagedRows(matters, 10);

  if (selectionRequired) {
    return <ClientRecordPicker associations={associations} onSelect={setActiveClientRecordId} />;
  }

  if (loading) {
    return <LoadingSpinner fullPage />;
  }

  if (!lawFirm) {
    return (
      <ResourceNotFoundPage
        resourceLabel="law firm"
        title="We couldn't open this client portal"
        description="This law firm link may be outdated, or your client access may have changed."
        primaryAction={{
          label: "Back to client dashboard",
          href: "/client/dashboard",
        }}
        secondaryAction={{
          label: "Back home",
          href: "/",
        }}
      />
    );
  }

  return (
    <div className="p-8 max-w-[1600px] mx-auto min-w-0">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-accent-solid rounded-xl flex items-center justify-center">
            <Building2 className="w-5 h-5 text-accent-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-on-surface">{lawFirm.name}</h1>
            <p className="text-sm text-on-surface-muted">Your Matters & Information</p>
          </div>
        </div>
      </div>

      <ErrorNotification error={error} onClose={() => setError(null)} />

      <IdentityVerificationCard
        lawFirmId={lawFirmId}
        clientRecordId={clientRecordId}
        enabled={activeAssociation?.clientType !== 'company'}
      />

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-5">
          <SectionLabel>My Matters</SectionLabel>
          <p className="text-2xl font-bold text-on-surface mt-1">{matters.length}</p>
        </div>
        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-5">
          <SectionLabel>Active Matters</SectionLabel>
          <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 mt-1">
            {matters.filter(c => c.status === 'active').length}
          </p>
        </div>
        <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] p-5 flex items-center justify-center">
          <NavigationLink href={`/client/messages/${lawFirmId}`} className="w-full py-2.5 px-4 rounded-xl inline-flex items-center justify-center gap-2 active:scale-[0.985] motion-reduce:active:scale-100 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer text-accent-foreground text-sm font-semibold bg-accent-solid hover:bg-accent-solid-hover transition-[background-color,transform] shadow-sm dark:shadow-none">
            <MessageSquare className="w-4 h-4" />
            Message Law Firm
          </NavigationLink>
        </div>
      </div>

      {/* Matters List */}
      <div className="bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
        <div className="px-5 py-4 border-b border-outline-subtle">
          <SectionLabel>My Matters</SectionLabel>
        </div>
        {matters.length === 0 ? (
          <ListEmptyState
            compact
            icon={<FileText className="w-8 h-8" />}
            title="No matters assigned to you yet"
            className="border-0"
          />
        ) : (
          <div className="divide-y divide-outline-subtle">
            {mattersPager.pagedRows.map((matterItem) => (
              <NavigationLink
                key={matterItem.id}
                href={`/client/lawfirm/${lawFirmId}/matters/${matterItem.id}`}
                aria-label={matterItem.name}
                className="w-full px-5 py-4 text-left hover:bg-surface-hover transition group"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-on-surface group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors">{matterItem.name}</h3>
                    {matterItem.matterNumber && (
                      <p className="text-xs text-on-surface-muted mt-0.5">Matter #: {matterItem.matterNumber}</p>
                    )}
                    <MatterStatusBadge status={matterItem.status} className="mt-1.5" />
                  </div>
                  <ChevronRight className="w-4 h-4 text-on-surface-muted group-hover:text-accent-emphasis dark:group-hover:text-accent-emphasis transition-colors" />
                </div>
              </NavigationLink>
            ))}
            {mattersPager.total > mattersPager.rowsPerPage && (
              <div className="px-5 py-3">
                <AutoPager pager={mattersPager} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
