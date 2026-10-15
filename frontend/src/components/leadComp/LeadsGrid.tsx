"use client";

import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Mail,
  Phone,
  UserPlus,
  UserRound,
} from 'lucide-react';
import useLeadsTable from "@/hooks/leadHooks/useLeadsTable";
import useLeadStages from "@/hooks/leadHooks/useLeadStages";
import ListSkeleton from "@/components/ui/ListSkeleton";
import ErrorNotification from "@/components/ErrorNotification";
import Button from "@/components/ui/Button";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListBusyIndicator from "@/components/ui/ListBusyIndicator";
import ListPager, { DEFAULT_ROWS_PER_PAGE_OPTIONS } from "@/components/ui/ListPager";
import ListToolbar from "@/components/ui/ListToolbar";
import PageHeader from "@/components/ui/PageHeader";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import type { Lead } from "@/types";
import ConvertLeadModal from "./ConvertLeadModal";
import IntakeFormsQuickAccess from "./IntakeFormsQuickAccess";
import LeadDetailModal from "./LeadDetailModal";
import Card from "@/components/ui/Card";
import SectionLabel from "@/components/ui/SectionLabel";
import SearchInput from "@/components/ui/SearchInput";

type Props = {
  lawFirmId: string;
};

export default function LeadsGrid({ lawFirmId }: Props) {
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("leads.manage");
  const canConvert = hasPermission("leads.convert");
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [convertLeadTarget, setConvertLeadTarget] = useState<Lead | null>(null);
  const [suppressHover, setSuppressHover] = useState(false);

  const { stages: leadStages } = useLeadStages(lawFirmId);
  const stagesById = useMemo(
    () => new Map(leadStages.map((stage) => [stage.id, stage])),
    [leadStages]
  );

  const table = useLeadsTable(lawFirmId);
  const {
    rows,
    total,
    loading,
    fetching,
    error: tableError,
    refetch,
    search: searchTerm,
    setSearch: setSearchTerm,
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
  } = table;

  const displayedError = error || tableError;
  const totalPages = Math.max(1, Math.ceil(total / rowsPerPage) || 1);
  const safePage = Math.min(page, totalPages);

  const refetchAll = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["leads", lawFirmId] });
    await refetch();
  }, [queryClient, lawFirmId, refetch]);

  const openCreate = () => {
    setDetailOpen(true);
  };

  const openLead = (lead: Lead) => {
    navigate(`/lawfirm/${lawFirmId}/leads/${lead.id}`);
  };

  return (
    <div className="min-h-screen bg-page">
      <div className="p-6 max-w-[1600px] mx-auto space-y-6">
        <PageHeader
          eyebrow="Client Management"
          title="Leads"
          description="Track prospective clients through your intake pipeline."
          actions={
            canManage ? (
              <Button
                size="compact"
                onClick={openCreate}
                icon={<UserPlus size={14} />}
                className="md:hidden"
              >
                Add Lead
              </Button>
            ) : undefined
          }
        />

        {canManage && <IntakeFormsQuickAccess lawFirmId={lawFirmId} />}

        <ListToolbar className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center md:justify-between">
          <SearchInput
            className="w-full md:min-w-64 md:max-w-sm md:flex-1"
            placeholder="Search by name, email, or organization…"
            value={searchTerm}
            onChange={(next) => {
              setSearchTerm(next);
              setSuppressHover(true);
            }}
            onClear={() => setSearchTerm("")}
          />
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {canManage && (
              <Button
                size="compact"
                onClick={openCreate}
                icon={<UserPlus size={14} />}
                className="max-md:hidden whitespace-nowrap"
              >
                Add Lead
              </Button>
            )}
          </div>
        </ListToolbar>

        <ErrorNotification error={displayedError} onClose={() => setError(null)} onRetry={tableError ? () => void refetch() : undefined} />

        <div className="mb-4 flex items-center gap-3">
          <SectionLabel>
            All Leads ({total})
          </SectionLabel>
          <ListBusyIndicator busy={fetching && !loading} />
        </div>

        <div className="space-y-3" aria-busy={fetching}>
          {(loading || fetching) && rows.length === 0 ? (
            <ListSkeleton rows={Math.min(rowsPerPage, 10)} label="Loading leads" />
          ) : rows.length === 0 ? (
            tableError ? null : <ListEmptyState
              icon={<UserRound size={32} />}
              title={searchTerm ? "No leads match your search" : "No leads yet"}
              message={
                searchTerm
                  ? "Try a different search term."
                  : "Add a lead or share an intake form to start filling your pipeline."
              }
            />
          ) : (
            <Card className="divide-y divide-outline-subtle">
              {rows.map((lead) => (
                <div
                  key={lead.id}
                  role="button"
                  tabIndex={0}
                  className={`flex items-center gap-4 px-5 py-4 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                    suppressHover
                      ? "transition-none"
                      : "group hover:bg-surface-hover transition-colors"
                  }`}
                  onClick={() => openLead(lead)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openLead(lead);
                    }
                  }}
                >
                  <div className="w-10 h-10 rounded-full bg-accent-soft dark:bg-accent-soft flex items-center justify-center shrink-0">
                    <span className="text-sm font-semibold text-accent-emphasis dark:text-accent-emphasis">
                      {(lead.name || "?").charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-on-surface truncate">
                        {lead.name || "Unnamed"}
                      </p>
                      {lead.stageId && stagesById.get(lead.stageId) && (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-outline-subtle bg-surface-alt px-2 py-0.5 text-[11px] font-medium text-on-surface-secondary shrink-0">
                          <span
                            className="h-2 w-2 rounded-full shrink-0"
                            style={{
                              backgroundColor: stagesById.get(lead.stageId)?.color || "#6366f1",
                            }}
                          />
                          {stagesById.get(lead.stageId)?.name}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 min-w-0 flex-wrap">
                      {lead.email && (
                        <p className="text-xs text-on-surface-secondary overflow-hidden flex items-center gap-1 min-w-0">
                          <Mail size={11} className="shrink-0" />
                          <span className="truncate">{lead.email}</span>
                        </p>
                      )}
                      {lead.phone && (
                        <p className="text-xs text-on-surface-secondary overflow-hidden flex items-center gap-1 min-w-0">
                          <Phone size={11} className="shrink-0" />
                          <span className="truncate">{lead.phone}</span>
                        </p>
                      )}
                      {lead.organization && (
                        <p className="text-xs text-on-surface-secondary overflow-hidden flex items-center gap-1 min-w-0">
                          <Building2 size={11} className="shrink-0" />
                          <span className="truncate">{lead.organization}</span>
                        </p>
                      )}
                    </div>
                  </div>
                  {canConvert && !lead.convertedAt && (
                    <Button
                      type="secondary"
                      size="small"
                      className="shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConvertLeadTarget(lead);
                        setConvertOpen(true);
                      }}
                    >
                      Convert to Client
                    </Button>
                  )}
                </div>
              ))}
            </Card>
          )}
        </div>

        {total > 0 && (
          <ListPager
            page={safePage}
            totalPages={totalPages}
            total={total}
            rowsPerPage={rowsPerPage}
            onPageChange={setPage}
            onRowsPerPageChange={setRowsPerPage}
            rowsPerPageOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
            busy={fetching}
            serverPaged
          />
        )}

        <LeadDetailModal
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
          lawFirmId={lawFirmId}
          lead={null}
          onAfter={refetchAll}
        />

        {convertLeadTarget && (
          <ConvertLeadModal
            open={convertOpen}
            onClose={() => setConvertOpen(false)}
            lawFirmId={lawFirmId}
            lead={convertLeadTarget}
            onAfter={refetchAll}
          />
        )}
      </div>
    </div>
  );
}
