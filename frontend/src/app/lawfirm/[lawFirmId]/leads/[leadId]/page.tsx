"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import dayjs from "dayjs";
import {
  Building2, Calendar, CheckCircle2, Layers, Mail, Pencil, Phone,
  StickyNote, UserRound,
} from "lucide-react";
import Button from "@/components/ui/Button";
import { useLeadById } from "@/hooks/leadHooks/useLeads";
import useLeadStages from "@/hooks/leadHooks/useLeadStages";
import BackButton from "@/components/ui/BackButton";
import ConvertLeadModal from "@/components/leadComp/ConvertLeadModal";
import LeadDetailModal, { intakeBadge } from "@/components/leadComp/LeadDetailModal";
import QuickAddLeadNoteModal from "@/components/leadComp/QuickAddLeadNoteModal";
import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import ErrorNotification from "@/components/ErrorNotification";
import ListEmptyState from "@/components/ui/ListEmptyState";
import LoadingSpinner from "@/components/LoadingSpinner";
import PageHeader from "@/components/ui/PageHeader";
import RequirePermission from "@/components/ui/RequirePermission";
import StatusBadge from "@/components/ui/StatusBadge";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import leadsService from "@/services/leads.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";

const CARD_CLASS = "bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm";

/** One label + value line in the details card. Renders nothing without a value. */
function DetailLine({
  icon, label, children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  if (!children) return null;
  return (
    <div className="flex items-start gap-2.5 min-w-0">
      <span className="text-on-surface-muted shrink-0 mt-0.5">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-on-surface-muted">{label}</p>
        <div className="text-sm text-on-surface break-words">{children}</div>
      </div>
    </div>
  );
}

function LeadDetail({ lawFirmId, leadId }: { lawFirmId: string; leadId: string }) {
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("leads.manage");
  const canConvert = hasPermission("leads.convert");

  const { lead, loading, error, refresh } = useLeadById(lawFirmId, leadId);
  const { stages } = useLeadStages(lawFirmId);
  const stage = useMemo(
    () => stages.find((s) => s.id === lead?.stageId) || null,
    [stages, lead?.stageId]
  );
  const stageOptions: DropdownOption[] = useMemo(
    () => [
      { label: "Unassigned", value: "" },
      ...stages.map((s) => ({ label: s.name, value: s.id, dotColor: s.color || "#6366f1" })),
    ],
    [stages]
  );

  const [editOpen, setEditOpen] = useState(false);
  const [quickNoteOpen, setQuickNoteOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [stageSaving, setStageSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleQuickStageChange = async (newStageId: string) => {
    if (!lead) return;
    setStageSaving(true);
    setActionError(null);
    try {
      await leadsService.updateLead(lawFirmId, lead.id, { stageId: newStageId || null });
      await refresh();
    } catch (err) {
      setActionError(getErrorMessage(err) || "Failed to update stage");
    } finally {
      setStageSaving(false);
    }
  };

  if (loading) return <LoadingSpinner fullPage />;

  if (!lead) {
    return (
      <div className="min-h-screen bg-page">
        <div className="p-4 pl-5 pt-10 md:p-6 md:pt-14 max-w-[1600px] mx-auto space-y-6 min-w-0">
          <ErrorNotification error={error || "Lead not found."} onRetry={() => void refresh()} />
        </div>
      </div>
    );
  }

  const alreadyConverted = !!lead.convertedAt;
  const badge = intakeBadge(lead.latestIntakeSubmission);

  return (
    <div className="min-h-screen bg-page">
      <div className="p-4 pl-5 pt-10 md:p-6 md:pt-14 max-w-[1600px] mx-auto space-y-6 min-w-0">
        <ErrorNotification error={actionError || error} onClose={() => setActionError(null)} />

        <BackButton href={`/lawfirm/${lawFirmId}/clients?tab=leads`} label="Back to leads" variant="link" />

        <PageHeader
          eyebrow="Lead"
          title={lead.name || "Unnamed"}
          description={lead.organization || undefined}
          actions={
            canManage && (
              <>
                <Dropdown
                  value={lead.stageId || ""}
                  onChange={handleQuickStageChange}
                  options={stageOptions}
                  busy={stageSaving}
                  className="w-48"
                  ariaLabel="Change stage"
                  portal
                />
                <Button
                  type="secondary"
                  size="compact"
                  onClick={() => setEditOpen(true)}
                  icon={<Pencil size={14} />}
                >
                  Edit Lead
                </Button>
              </>
            )
          }
        >
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {stage && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-outline-subtle bg-surface-alt px-2.5 py-0.5 text-xs font-medium text-on-surface-secondary">
                <span
                  className="h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: stage.color || "#6366f1" }}
                />
                {stage.name}
              </span>
            )}
            {alreadyConverted && (
              <StatusBadge variant="success">
                <CheckCircle2 size={11} /> Converted
              </StatusBadge>
            )}
          </div>
        </PageHeader>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className={`${CARD_CLASS} lg:col-span-1 space-y-4`}>
            <h2 className="text-sm font-semibold text-on-surface">Details</h2>

            <DetailLine icon={<UserRound size={15} />} label="Organization">
              {lead.organization}
            </DetailLine>
            <DetailLine icon={<Mail size={15} />} label="Email">
              {lead.email && (
                <a href={`mailto:${lead.email}`} className="text-accent-emphasis hover:underline">
                  {lead.email}
                </a>
              )}
            </DetailLine>
            <DetailLine icon={<Phone size={15} />} label="Phone">
              {lead.phone && (
                <a href={`tel:${lead.phone}`} className="hover:underline">{lead.phone}</a>
              )}
            </DetailLine>
            <DetailLine icon={<Building2 size={15} />} label="Referral source">
              {lead.referralSource}
            </DetailLine>
            <DetailLine icon={<Layers size={15} />} label="Stage">
              {stage?.name}
            </DetailLine>
            <DetailLine icon={<Calendar size={15} />} label="Stage date">
              {lead.stageDate ? dayjs(lead.stageDate).format("MMM D, YYYY") : null}
            </DetailLine>
            <div className="flex items-start gap-2.5 min-w-0">
              <span className="text-on-surface-muted shrink-0 mt-0.5"><StickyNote size={15} /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-on-surface-muted">Notes</p>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => setQuickNoteOpen(true)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-outline-subtle px-2 py-1 text-[11px] font-medium text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                    >
                      <StickyNote size={12} /> {lead.notes ? "Edit note" : "Add note"}
                    </button>
                  )}
                </div>
                <p className="mt-1 text-sm text-on-surface break-words whitespace-pre-wrap">
                  {lead.notes || <span className="text-on-surface-muted">No notes yet</span>}
                </p>
              </div>
            </div>
          </div>

          <div className={`${CARD_CLASS} lg:col-span-2 space-y-4`}>
            <div>
              <h2 className="text-sm font-semibold text-on-surface">Intake form</h2>
              <p className="text-xs text-on-surface-secondary mt-0.5">
                Status of the most recent intake form sent to this lead.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <StatusBadge variant={badge.variant}>{badge.label}</StatusBadge>
              {lead.latestIntakeSubmission?.sentAt && (
                <span className="text-xs text-on-surface-muted">
                  Sent {dayjs(lead.latestIntakeSubmission.sentAt).format("MMM D, YYYY")}
                </span>
              )}
            </div>

            {canManage && !alreadyConverted && (
              <Button type="secondary" onClick={() => setEditOpen(true)}>
                {lead.latestIntakeSubmission ? "Manage intake form" : "Send intake form"}
              </Button>
            )}

            {!alreadyConverted && canConvert && (
              <div className="pt-4 mt-4 border-t border-outline-subtle">
                <h2 className="text-sm font-semibold text-on-surface mb-1">Convert to client</h2>
                <p className="text-xs text-on-surface-secondary mb-3">
                  Turn this lead into a client, optionally opening a matter for them.
                </p>
                <Button type="primary" onClick={() => setConvertOpen(true)}>
                  Convert to Client
                </Button>
              </div>
            )}

            {alreadyConverted && (
              <div className="pt-4 mt-4 border-t border-outline-subtle">
                <ListEmptyState
                  compact
                  icon={<CheckCircle2 size={32} />}
                  title="This lead was converted"
                  message={
                    lead.convertedAt
                      ? `Converted on ${dayjs(lead.convertedAt).format("MMM D, YYYY")}.`
                      : undefined
                  }
                  action={
                    lead.convertedMatterId ? (
                      <Button
                        size="compact"
                        onClick={() => navigate(`/lawfirm/${lawFirmId}/matters/${lead.convertedMatterId}`)}
                      >
                        View matter
                      </Button>
                    ) : lead.convertedClientId ? (
                      <Button
                        size="compact"
                        onClick={() => navigate(`/lawfirm/${lawFirmId}/clients/${lead.convertedClientId}`)}
                      >
                        View client
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            )}
          </div>
        </div>

        <LeadDetailModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          lawFirmId={lawFirmId}
          lead={lead}
          onAfter={() => { refresh(); }}
        />

        <QuickAddLeadNoteModal
          open={quickNoteOpen}
          onClose={() => setQuickNoteOpen(false)}
          lawFirmId={lawFirmId}
          lead={lead}
          onAfter={async () => { await refresh(); }}
        />

        <ConvertLeadModal
          open={convertOpen}
          onClose={() => setConvertOpen(false)}
          lawFirmId={lawFirmId}
          lead={lead}
          onAfter={() => { refresh(); }}
        />
      </div>
    </div>
  );
}

export default function LeadDetailPage() {
  const params = useParams();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";
  const leadId = (Array.isArray(params?.leadId) ? params.leadId[0] : params?.leadId) || "";
  if (!lawFirmId || !leadId) return null;

  return (
    <RequirePermission permission="leads.view" page>
      <LeadDetail lawFirmId={lawFirmId} leadId={leadId} />
    </RequirePermission>
  );
}
