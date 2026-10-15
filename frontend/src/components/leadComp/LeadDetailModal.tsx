"use client";

import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import { useEffect, useId, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Button from "@/components/ui/Button";
import DatePicker from "@/components/ui/DatePicker";
import Dropdown, { type DropdownOption } from "@/components/ui/Dropdown";
import StatusBadge from "@/components/ui/StatusBadge";
import ErrorNotification from "@/components/ErrorNotification";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import Modal from "@/components/ui/Modal";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useNavigation } from "@/contexts/NavigationContext";
import leadsService from "@/services/leads.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import type { IntakeFormTemplate, Lead, LeadStage, LatestIntakeSubmission } from "@/types";
import ConvertLeadModal from "./ConvertLeadModal";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";
import FieldLabel from "@/components/ui/FieldLabel";
import ClientOrganizationAutocomplete from "@/components/clientComp/ClientOrganizationAutocomplete";

type Props = {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  /** null = create mode */
  lead: Lead | null;
  onAfter?: () => Promise<void> | void;
};

export type IntakeBadge = {
  label: string;
  variant: "neutral" | "info" | "warning" | "success";
};

export function intakeBadge(submission: LatestIntakeSubmission | null | undefined): IntakeBadge {
  if (!submission) return { label: "Not sent", variant: "neutral" };
  if (submission.status === "completed" || submission.completedAt) {
    return { label: "Completed", variant: "success" };
  }
  if (submission.deliveryStatus === "failed") return { label: "Email failed", variant: "warning" };
  if (submission.deliveryStatus === "pending") return { label: "Sending", variant: "neutral" };
  if (submission.openedAt) return { label: "Opened", variant: "info" };
  if (submission.status === "sent" || submission.sentAt) {
    return { label: "Sent", variant: "warning" };
  }
  return { label: "Not sent", variant: "neutral" };
}

const inputClass = FULL_INPUT_CLS;

export default function LeadDetailModal({ open, onClose, lawFirmId, lead, onAfter }: Props) {
  const fieldIds = useId();
  const isEdit = !!lead;
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission("leads.manage");
  const canConvert = hasPermission("leads.convert");
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [organization, setOrganization] = useState("");
  const [referralSource, setReferralSource] = useState("");
  const [notes, setNotes] = useState("");
  const [stageId, setStageId] = useState("");
  const [stageDate, setStageDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConvert, setShowConvert] = useState(false);
  const [showSendIntake, setShowSendIntake] = useState(false);
  const [intakeTemplateId, setIntakeTemplateId] = useState("");
  const [intakeEmail, setIntakeEmail] = useState("");
  const [sendingIntake, setSendingIntake] = useState(false);

  const { data: stages = [] } = useQuery<LeadStage[]>({
    queryKey: ["leadStages", lawFirmId],
    queryFn: () => leadsService.listStages(lawFirmId),
    enabled: open && !!lawFirmId,
  });

  const { data: templates = [] } = useQuery<IntakeFormTemplate[]>({
    queryKey: ["intakeForms", lawFirmId],
    queryFn: () => leadsService.listIntakeForms(lawFirmId),
    enabled: open && isEdit && canManage && !!lawFirmId,
  });

  // Fresh detail with latestIntakeSubmission when editing.
  const { data: detailLead } = useQuery<Lead>({
    queryKey: ["leads", lawFirmId, "detail", lead?.id ?? null],
    queryFn: () => leadsService.getLead(lawFirmId, lead!.id),
    enabled: open && isEdit && !!lead?.id,
    staleTime: 15_000,
  });

  const activeLead = detailLead ?? lead;
  const badge = intakeBadge(activeLead?.latestIntakeSubmission);

  const stageOptions: DropdownOption[] = useMemo(
    () => [
      { label: "Unassigned", value: "" },
      ...stages.map((s) => ({ label: s.name, value: s.id, dotColor: s.color || "#6366f1" })),
    ],
    [stages],
  );

  const activeTemplates = useMemo(
    () => templates.filter((t) => t.isActive),
    [templates],
  );

  const templateOptions: DropdownOption[] = useMemo(
    () => activeTemplates.map((t) => ({ label: t.name, value: t.id })),
    [activeTemplates],
  );

  useSeedOnOpen(open, () => {
    setError(null);
    setSubmitting(false);
    setShowConvert(false);
    setShowSendIntake(false);
    setSendingIntake(false);
    if (lead) {
      setName(lead.name || "");
      setEmail(lead.email || "");
      setPhone(lead.phone || "");
      setOrganization(lead.organization || "");
      setReferralSource(lead.referralSource || "");
      setNotes(lead.notes || "");
      setStageId(lead.stageId || "");
      setStageDate(lead.stageDate || "");
      setIntakeEmail(lead.email || "");
      setIntakeTemplateId("");
    } else {
      setName("");
      setEmail("");
      setPhone("");
      setOrganization("");
      setReferralSource("");
      setNotes("");
      setStageId("");
      setStageDate("");
      setIntakeEmail("");
      setIntakeTemplateId("");
    }
  });

  // Keep form in sync if the detail refetch returns while still open.
  useEffect(() => {
    if (!open || !detailLead) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs stage/email from refreshed detail without clearing in-progress edits of other fields
    setStageId((prev) => (prev === (lead?.stageId || "") ? detailLead.stageId || "" : prev));
    setStageDate((prev) => (prev === (lead?.stageDate || "") ? detailLead.stageDate || "" : prev));
    setIntakeEmail((prev) => (prev === (lead?.email || "") ? detailLead.email || "" : prev));
  }, [open, detailLead, lead?.stageId, lead?.stageDate, lead?.email]);

  useResetAfterClose(open, () => {
    setShowConvert(false);
    setShowSendIntake(false);
    setError(null);
  });

  const invalidateLeads = async () => {
    await queryClient.invalidateQueries({ queryKey: ["leads", lawFirmId] });
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      setError("Lead name is required");
      return;
    }
    if (!canManage && isEdit) return;

    try {
      setSubmitting(true);
      setError(null);
      const payload = {
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        organization: organization.trim() || null,
        referralSource: referralSource.trim() || null,
        notes: notes.trim() || null,
        stageId: stageId || null,
        stageDate: stageDate || null,
      };
      if (isEdit && lead) {
        await leadsService.updateLead(lawFirmId, lead.id, payload);
      } else {
        await leadsService.createLead(lawFirmId, payload);
      }
      await invalidateLeads();
      await onAfter?.();
      onClose();
    } catch (err) {
      setError(getErrorMessage(err) || (isEdit ? "Failed to update lead" : "Failed to create lead"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSendIntake = async () => {
    if (!lead || !intakeTemplateId) {
      setError("Select an intake form to send");
      return;
    }
    try {
      setSendingIntake(true);
      setError(null);
      await leadsService.sendIntakeForm(lawFirmId, lead.id, {
        intakeFormTemplateId: intakeTemplateId,
        email: intakeEmail.trim() || undefined,
      });
      await queryClient.invalidateQueries({
        queryKey: ["leads", lawFirmId, "detail", lead.id],
      });
      await invalidateLeads();
      setShowSendIntake(false);
      await onAfter?.();
    } catch (err) {
      setError(getErrorMessage(err) || "Failed to send intake form");
    } finally {
      setSendingIntake(false);
    }
  };

  const readOnly = isEdit && !canManage;
  const alreadyConverted = !!activeLead?.convertedAt;

  return (
    <>
      <Modal
        isOpen={open}
        onClose={onClose}
        dismissible={!submitting && !sendingIntake}
        title={isEdit ? "Lead details" : "Add Lead"}
        showClose={false}
        size="lg"
        bodyClassName="px-6 py-4 space-y-4 overflow-y-auto overflow-x-hidden styled-scrollbar"
        footer={
          <div className="w-full flex items-center justify-between gap-2">
            <div>
              {isEdit && canConvert && !alreadyConverted && (
                <Button type="secondary" onClick={() => setShowConvert(true)} disabled={submitting}>
                  Convert to Client
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button type="secondary" onClick={onClose} disabled={submitting || sendingIntake}>
                {readOnly ? "Close" : "Cancel"}
              </Button>
              {!readOnly && (
                <Button
                  type="primary"
                  onClick={handleSubmit}
                  loading={submitting}
                  disabled={submitting || !name.trim()}
                >
                  {submitting
                    ? isEdit
                      ? "Saving…"
                      : "Creating…"
                    : isEdit
                      ? "Save changes"
                      : "Add Lead"}
                </Button>
              )}
            </div>
          </div>
        }
      >
              <ErrorNotification error={error} onClose={() => setError(null)} />

              <div>
                <FieldLabel htmlFor={`${fieldIds}-name`}>Name *</FieldLabel>
                <input
                  id={`${fieldIds}-name`}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={inputClass}
                  placeholder="Full name"
                  disabled={readOnly}
                  required
                />
              </div>

              <div>
                <FieldLabel htmlFor={`${fieldIds}-email`}>Email</FieldLabel>
                <input
                  id={`${fieldIds}-email`}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputClass}
                  placeholder="email@example.com"
                  disabled={readOnly}
                />
              </div>

              <div>
                <FieldLabel htmlFor={`${fieldIds}-phone`}>Phone</FieldLabel>
                <input
                  id={`${fieldIds}-phone`}
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={inputClass}
                  placeholder="(555) 123-4567"
                  disabled={readOnly}
                />
              </div>

              <div>
                <FieldLabel htmlFor={`${fieldIds}-organization`}>Organization</FieldLabel>
                <ClientOrganizationAutocomplete
                  id={`${fieldIds}-organization`}
                  lawFirmId={lawFirmId}
                  value={organization}
                  onChange={setOrganization}
                  disabled={readOnly}
                />
              </div>

              <div>
                <FieldLabel htmlFor={`${fieldIds}-referralsource`}>Referral source</FieldLabel>
                <input
                  id={`${fieldIds}-referralsource`}
                  type="text"
                  value={referralSource}
                  onChange={(e) => setReferralSource(e.target.value)}
                  className={inputClass}
                  placeholder="How they found you"
                  disabled={readOnly}
                />
              </div>

              <div>
                <FieldLabel id={`${fieldIds}-stage-label`}>Stage</FieldLabel>
                <Dropdown
                  ariaLabelledBy={`${fieldIds}-stage-label`}
                  value={stageId}
                  onChange={setStageId}
                  options={stageOptions}
                  portal
                  disabled={readOnly}
                />
              </div>

              <div>
                <FieldLabel>Stage date</FieldLabel>
                <DatePicker
                  value={stageDate}
                  onChange={setStageDate}
                  placeholder="No date set"
                  disabled={readOnly}
                  aria-label="Stage date"
                />
              </div>

              <div>
                <FieldLabel htmlFor={`${fieldIds}-notes`}>Notes</FieldLabel>
                <textarea
                  id={`${fieldIds}-notes`}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className={`${inputClass} min-h-[80px] resize-y`}
                  placeholder="Internal notes"
                  disabled={readOnly}
                  rows={3}
                />
              </div>

              {isEdit && canManage && !alreadyConverted && (
                <div className="rounded-lg border border-outline bg-surface-alt p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-on-surface">Intake form</span>
                      <StatusBadge variant={badge.variant}>{badge.label}</StatusBadge>
                    </div>
                    <Button
                      type="secondary"
                      onClick={() => setShowSendIntake((v) => !v)}
                      disabled={activeTemplates.length === 0}
                    >
                      {showSendIntake ? "Cancel" : "Send intake form"}
                    </Button>
                  </div>
                  {activeTemplates.length === 0 && (
                    <p className="text-xs text-on-surface-muted">
                      No active intake forms. Create one under Matter Setup →{" "}
                      <button
                        type="button"
                        onClick={() => {
                          onClose();
                          navigate(`/lawfirm/${lawFirmId}/settings/matter-config?tab=intakeForms`);
                        }}
                        className="cursor-pointer font-medium text-on-surface underline underline-offset-2 hover:text-accent-emphasis"
                      >
                        Intake Forms
                      </button>
                      .
                    </p>
                  )}
                  {showSendIntake && (
                    <div className="space-y-3">
                      <Dropdown
                        label="Form"
                        value={intakeTemplateId}
                        onChange={setIntakeTemplateId}
                        options={templateOptions}
                        placeholder="Select a form"
                        portal
                      />
                      <div>
                        <FieldLabel htmlFor={`${fieldIds}-intakeemail`}>
                          Send to email
                        </FieldLabel>
                        <input
                          id={`${fieldIds}-intakeemail`}
                          type="email"
                          value={intakeEmail}
                          onChange={(e) => setIntakeEmail(e.target.value)}
                          className={inputClass}
                          placeholder="email@example.com"
                        />
                      </div>
                      <Button
                        type="primary"
                        onClick={handleSendIntake}
                        loading={sendingIntake}
                        disabled={sendingIntake || !intakeTemplateId}
                      >
                        Send
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {isEdit && alreadyConverted && (
                <p className="text-sm text-on-surface-secondary">
                  This lead was converted
                  {activeLead?.convertedAt
                    ? ` on ${new Date(activeLead.convertedAt).toLocaleDateString()}`
                    : ""}
                  .
                </p>
              )}
      </Modal>

      {isEdit && lead && (
        <ConvertLeadModal
          open={showConvert}
          onClose={() => setShowConvert(false)}
          lawFirmId={lawFirmId}
          lead={activeLead || lead}
          onAfter={async () => {
            await invalidateLeads();
            await onAfter?.();
            onClose();
          }}
        />
      )}
    </>
  );
}
