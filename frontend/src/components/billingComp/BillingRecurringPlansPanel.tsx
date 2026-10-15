"use client";

import { useId, useState } from "react";
import dayjs from "dayjs";
import { Repeat } from "lucide-react";
import Button from "@/components/ui/Button";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import StatusBadge from "@/components/ui/StatusBadge";
import { billingPlanStatusMeta } from "@/constants/statusMeta";
import type { BillingPlan } from "@/types";
import type { CreateBillingPlanPayload } from "@/services/billing.service";
import DatePicker from "@/components/ui/DatePicker";
import Dropdown from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import type { FullLookupItem } from "@/hooks/useEntityLookup";
import ErrorNotification from "@/components/ErrorNotification";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import Modal from "@/components/ui/Modal";
import { formatCurrency, getBillingPlanDestination } from "./utils";
import { formatHoursMinutes } from "@/lib/utils/format";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { AutoPager } from "@/components/ui/ListPager";
import usePagedRows from "@/hooks/usePagedRows";
import FieldLabel from "@/components/ui/FieldLabel";

interface BillingRecurringPlansPanelProps {
  lawFirmId: string;
  plans: BillingPlan[];
  loading?: boolean;
  onCreatePlan: (payload: CreateBillingPlanPayload) => Promise<void>;
}

type ContextType = "matter" | "client";
type ContextValue = `matter:${string}` | `client:${string}`;

const CONTEXT_TYPE_OPTIONS = [
  { value: "matter", label: "Matter" },
  { value: "client", label: "Client" },
];

export default function BillingRecurringPlansPanel({
  lawFirmId,
  plans,
  loading = false,
  onCreatePlan,
}: BillingRecurringPlansPanelProps) {
  const fieldIds = useId();
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canManagePlans = hasPermission("billing.managePlans");
  const [open, setOpen] = useState(false);
  // The plan bills to one matter or one client. The type picker chooses which
  // entity is being searched; the id combines with it into the
  // `matter:<id>` / `client:<id>` value the save handler splits apart.
  const [contextType, setContextType] = useState<ContextType>("matter");
  const [contextId, setContextId] = useState("");
  const contextValue: ContextValue | "" = contextId ? `${contextType}:${contextId}` : "";
  const [name, setName] = useState("Evergreen Retainer");
  const [amount, setAmount] = useState("");
  const [includedHours, setIncludedHours] = useState("");
  const [intervalUnit, setIntervalUnit] = useState<"week" | "month">("month");
  const [intervalCount, setIntervalCount] = useState("1");
  const [startDate, setStartDate] = useState(dayjs().format("YYYY-MM-DD"));
  const [defaultDueDays, setDefaultDueDays] = useState("0");
  const [billingEmail, setBillingEmail] = useState("");
  const [defaultClientId, setDefaultClientId] = useState("");
  const [notes, setNotes] = useState("");
  const [endCondition, setEndCondition] = useState<"manual" | "matter_closed" | "date">("manual");
  const [endDate, setEndDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The tab is the only place plans are listed, so it has to reach all of them.
  const plansPager = usePagedRows(plans, 10, String(plans.length));

  // The picker hands back the whole matter, which is where the "Matter Client"
  // dropdown below gets its options. A slim lookup row carries no client list.
  const [pickedMatter, setPickedMatter] = useState<FullLookupItem | null>(null);
  const matterClients =
    contextType === "matter" && pickedMatter?.id === contextId
      ? ((pickedMatter.clients as { id: string; name: string }[] | undefined) ?? [])
      : [];

  async function handleCreate() {
    if (!contextValue) {
      setError("Select a matter or client for the plan.");
      return;
    }
    if (!amount || Number(amount) <= 0) {
      setError("Enter a valid recurring amount.");
      return;
    }

    const entityId = contextId;
    setSaving(true);
    setError(null);
    try {
      await onCreatePlan({
        contextType,
        entityId,
        name: name.trim() || "Evergreen Retainer",
        amount: Number(amount),
        includedHours: includedHours ? Number(includedHours) : 0,
        intervalUnit,
        intervalCount: Number(intervalCount) || 1,
        startDate,
        defaultDueDays: Number(defaultDueDays) || 0,
        billingEmail: billingEmail.trim() || null,
        defaultClientId: contextType === "matter" ? (defaultClientId || null) : null,
        notes: notes.trim() || null,
        endCondition,
        endDate: endCondition === "date" ? (endDate || null) : null,
      });
      setOpen(false);
      setContextType("matter");
      setContextId("");
      setPickedMatter(null);
      setAmount("");
      setIncludedHours("");
      setBillingEmail("");
      setDefaultClientId("");
      setNotes("");
      setEndCondition("manual");
      setEndDate("");
    } catch (err) {
      setError(getErrorMessage(err, "Failed to create billing plan"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="bg-surface border border-outline rounded-xl p-5">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.12em] uppercase text-on-surface-muted">
            Repeat Billing
          </p>
          <h3 className="text-lg font-semibold text-on-surface mt-1">
            Weekly and monthly billing plans
          </h3>
        </div>
        {canManagePlans && (
          <Button type="primary" onClick={() => setOpen(true)}>
            Add Evergreen Retainer Plan
          </Button>
        )}
      </div>

      {/* Reserve a consistent height so the panel matches the other billing tabs */}
      <div className="min-h-[560px]">
      {loading ? (
        <ListSkeleton rows={6} label="Loading billing plans" />
      ) : plans.length === 0 ? (
        <div className="flex h-[560px] items-center justify-center">
          <ListEmptyState
            icon={<Repeat size={32} />}
            title="No billing plans yet"
            message="Set up an evergreen retainer to bill a matter or client automatically on a weekly or monthly schedule."
            action={
              canManagePlans && (
                <Button type="primary" onClick={() => setOpen(true)}>
                  Add Evergreen Retainer Plan
                </Button>
              )
            }
          />
        </div>
      ) : (
        <div className="space-y-3">
          {plansPager.pagedRows.map((plan) => {
            const readyPeriods = (plan.periods || []).filter((period) => period.status === "ready_to_bill").length;
            return (
              <div
                key={plan.id}
                className="rounded-lg border border-outline px-4 py-3 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 cursor-pointer transition-[border-color,box-shadow] hover:border-accent-border-soft hover:shadow-sm dark:hover:border-accent-border-soft"
                role="button"
                tabIndex={0}
                onClick={() => navigate(getBillingPlanDestination(lawFirmId, plan.id))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    navigate(getBillingPlanDestination(lawFirmId, plan.id));
                  }
                }}
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-on-surface">{plan.name}</span>
                    <StatusBadge variant={billingPlanStatusMeta(plan.status).variant}>
                      {billingPlanStatusMeta(plan.status).label}
                    </StatusBadge>
                  </div>
                  <p className="text-sm text-on-surface-secondary mt-1">
                    {[plan.matterName, plan.clientName].filter(Boolean).join(" • ") || "Recurring billing plan"}
                  </p>
                  <p className="text-sm text-on-surface-muted mt-1">
                    {formatCurrency(plan.amount)} every {plan.intervalCount} {plan.intervalUnit}
                    {plan.intervalCount > 1 ? "s" : ""} • {formatHoursMinutes(plan.includedHours)} included
                    {plan.endCondition === "matter_closed" && " • ends when matter closes"}
                    {plan.endCondition === "date" && plan.endDate && ` • ends ${dayjs(plan.endDate).format("MMM D, YYYY")}`}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-base font-semibold text-on-surface">
                    Next run {plan.nextRunDate ? dayjs(plan.nextRunDate).format("MMM D, YYYY") : "TBD"}
                  </p>
                  <p className="text-sm text-on-surface-muted">
                    {readyPeriods} period{readyPeriods === 1 ? "" : "s"} ready to bill
                  </p>
                </div>
              </div>
            );
          })}
          <AutoPager pager={plansPager} />
        </div>
      )}
      </div>

      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        dismissible={!saving}
        title="New Evergreen Retainer Plan"
        size="2xl"
        footer={
          <>
            <Button type="secondary" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="primary"
              onClick={handleCreate}
              loading={saving}
              disabled={saving || !contextValue || !amount || Number(amount) <= 0}
            >
              Create Plan
            </Button>
          </>
        }
      >
        <ErrorNotification error={error} onClose={() => setError(null)} compact />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Dropdown
            label="Bill this plan to"
            value={contextType}
            onChange={(val) => {
              setContextType(val as ContextType);
              setContextId("");
              setPickedMatter(null);
              setDefaultClientId("");
            }}
            options={CONTEXT_TYPE_OPTIONS}
            portal
          />
          <EntityPicker<FullLookupItem>
            key={contextType}
            entity={contextType === "matter" ? "matters" : "clients"}
            lawFirmId={lawFirmId}
            label={contextType === "matter" ? "Matter *" : "Client *"}
            value={contextId}
            onChange={(val) => {
              setContextId(val);
              setDefaultClientId("");
            }}
            onSelectItem={(item) => setPickedMatter(contextType === "matter" ? item : null)}
            full={contextType === "matter"}
            placeholder={contextType === "matter" ? "Select a matter..." : "Select a client..."}
            portal
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <FieldLabel htmlFor={`${fieldIds}-name`}>Plan Name</FieldLabel>
            <input
              id={`${fieldIds}-name`}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full border border-input-border rounded-md px-3 py-2 text-sm bg-input-bg text-on-surface"
            />
          </div>
          <div>
            <FieldLabel htmlFor={`${fieldIds}-billingemail`}>Billing Email</FieldLabel>
            <input
              id={`${fieldIds}-billingemail`}
              type="email"
              value={billingEmail}
              onChange={(event) => setBillingEmail(event.target.value)}
              className="w-full border border-input-border rounded-md px-3 py-2 text-sm bg-input-bg text-on-surface"
            />
            <p className="text-xs text-on-surface-muted mt-1">Used when sending the invoice. No email is sent on create.</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <FieldLabel htmlFor={`${fieldIds}-amount`}>Amount *</FieldLabel>
            <input
              id={`${fieldIds}-amount`}
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="w-full border border-input-border rounded-md px-3 py-2 text-sm bg-input-bg text-on-surface"
            />
          </div>
          <div>
            <FieldLabel htmlFor={`${fieldIds}-includedhours`}>Included Hours</FieldLabel>
            <input
              id={`${fieldIds}-includedhours`}
              type="number"
              min="0"
              step="0.1"
              value={includedHours}
              onChange={(event) => setIncludedHours(event.target.value)}
              className="w-full border border-input-border rounded-md px-3 py-2 text-sm bg-input-bg text-on-surface"
            />
          </div>
          <div>
            <FieldLabel htmlFor={`${fieldIds}-intervalcount`}>Every</FieldLabel>
            <input
              id={`${fieldIds}-intervalcount`}
              type="number"
              min="1"
              value={intervalCount}
              onChange={(event) => setIntervalCount(event.target.value)}
              className="w-full border border-input-border rounded-md px-3 py-2 text-sm bg-input-bg text-on-surface"
            />
          </div>
          <div>
            <Dropdown
              label="Unit"
              value={intervalUnit}
              onChange={(val) => setIntervalUnit(val as "week" | "month")}
              options={[
                { label: "Week", value: "week" },
                { label: "Month", value: "month" },
              ]}
              portal
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <FieldLabel id={`${fieldIds}-start-date-label`}>Start Date</FieldLabel>
            <DatePicker
              ariaLabelledBy={`${fieldIds}-start-date-label`}
              value={startDate} onChange={setStartDate} className="w-full" />
          </div>
          <div>
            <FieldLabel htmlFor={`${fieldIds}-defaultduedays`}>Default Due Days</FieldLabel>
            <input
              id={`${fieldIds}-defaultduedays`}
              type="number"
              min="0"
              value={defaultDueDays}
              onChange={(event) => setDefaultDueDays(event.target.value)}
              className="w-full border border-input-border rounded-md px-3 py-2 text-sm bg-input-bg text-on-surface"
            />
          </div>
          <div>
            <Dropdown
              label="Matter Client"
              value={defaultClientId}
              onChange={setDefaultClientId}
              disabled={matterClients.length === 0}
              options={[
                { label: "No default client", value: "" },
                ...matterClients.map((client) => ({
                  label: client.name,
                  value: client.id,
                })),
              ]}
              portal
            />
          </div>
        </div>

        <div>
          <FieldLabel htmlFor={`${fieldIds}-notes`}>Notes</FieldLabel>
          <textarea
            id={`${fieldIds}-notes`}
            rows={3}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
              className="w-full border border-input-border rounded-md px-3 py-2 text-sm bg-input-bg text-on-surface"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-on-surface mb-2">When does this evergreen retainer end?</label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="manual"
                checked={endCondition === "manual"}
                onChange={() => setEndCondition("manual")}
                className="accent-blue-600"
              />
              <span className="text-sm text-on-surface">Manually (I&apos;ll end it myself)</span>
            </label>
            {contextValue.startsWith("matter:") && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  value="matter_closed"
                  checked={endCondition === "matter_closed"}
                  onChange={() => setEndCondition("matter_closed")}
                  className="accent-blue-600"
                />
                <span className="text-sm text-on-surface">When the matter is closed</span>
              </label>
            )}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="date"
                checked={endCondition === "date"}
                onChange={() => setEndCondition("date")}
                className="accent-blue-600"
              />
              <span className="text-sm text-on-surface">On a specific date</span>
            </label>
          </div>
          {endCondition === "date" && (
            <div className="mt-2">
              <DatePicker value={endDate} onChange={setEndDate} className="w-full" />
            </div>
          )}
        </div>
      </Modal>
    </section>
  );
}
