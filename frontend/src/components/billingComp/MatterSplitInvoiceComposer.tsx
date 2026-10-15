"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Users, Percent, DollarSign, Equal, SlidersHorizontal } from "lucide-react";
import Button from "@/components/ui/Button";
import SegmentedToggle from "@/components/ui/SegmentedToggle";
import billingService from "@/services/billing.service";
import type { MatterClient, InvoiceFlatFee, InvoiceLineItem, SplitBillingMode } from "@/types";
import { formatCurrency } from "./utils";
import { formatHoursMinutes } from "@/lib/utils/format";
import {
  buildBalancedHoursFromAmounts,
  buildBalancedPercentagesFromAmounts,
  roundSplitValue,
} from "./splitAllocation";
import Checkbox from "@/components/ui/Checkbox";
import ShowMoreButton from "@/components/ui/ShowMoreButton";
import CollapsibleList from "@/components/ui/CollapsibleList";
import { INPUT_CLS } from "@/components/ui/inputClasses";
import FieldLabel from "@/components/ui/FieldLabel";
import { lineSourceId } from "@/lib/billing/lineSource";

// How many items each list in the composer shows before the "Show N more" toggle.
const LIST_PREVIEW_LIMIT = 5;

type SplitSourceRow =
  | ({ sourceType: "time" } & InvoiceLineItem)
  | ({ sourceType: "flat_fee" } & InvoiceFlatFee);

interface SplitInvoiceConfig {
  invoiceName: string;
  invoiceNumber: string;
  billingEmail: string;
}

interface MatterSplitInvoiceComposerProps {
  lawFirmId: string;
  matterId: string;
  matterClients: MatterClient[];
  initialSelectedClientIds?: string[];
  invoiceDate: string;
  dueDate: string;
  notes: string;
  remitTo: {
    name: string;
    address: string;
    city: string;
    state: string;
    zip: string;
  };
  baseInvoiceName: string;
  baseInvoiceNumber: string;
  timeEntries: InvoiceLineItem[];
  flatFees: InvoiceFlatFee[];
  onValidationError: (message: string | null) => void;
  onCreated: (result: { createdCount: number; splitGroupId: string }) => void;
}

function distributeAmount(total: number, weights: number[]) {
  if (weights.length === 0) return [];
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightTotal <= 0) return weights.map(() => 0);

  const distributed = weights.map((weight) => roundSplitValue((total * weight) / weightTotal));
  const allocated = distributed.reduce((sum, amount) => sum + amount, 0);
  const diff = roundSplitValue(total - allocated);
  if (Math.abs(diff) >= 0.01) {
    distributed[distributed.length - 1] = roundSplitValue(distributed[distributed.length - 1] + diff);
  }
  return distributed;
}

function buildRowKey(row: SplitSourceRow) {
  return `${row.sourceType}:${row.id}`;
}

export default function MatterSplitInvoiceComposer({
  lawFirmId,
  matterId,
  matterClients,
  initialSelectedClientIds = [],
  invoiceDate,
  dueDate,
  notes,
  remitTo,
  baseInvoiceName,
  baseInvoiceNumber,
  timeEntries,
  flatFees,
  onValidationError,
  onCreated,
}: MatterSplitInvoiceComposerProps) {
  const fieldIds = useId();
  const sourceRows = useMemo<SplitSourceRow[]>(
    () => [
      ...timeEntries.map((entry) => ({ ...entry, sourceType: "time" as const })),
      ...flatFees.map((fee) => ({ ...fee, sourceType: "flat_fee" as const })),
    ],
    [flatFees, timeEntries],
  );
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>([]);
  const [splitMode, setSplitMode] = useState<SplitBillingMode>("equal");
  const [allocations, setAllocations] = useState<Record<string, Record<string, number>>>({});
  const [invoiceConfigs, setInvoiceConfigs] = useState<Record<string, SplitInvoiceConfig>>({});
  const [helperPercentages, setHelperPercentages] = useState<Record<string, string>>({});
  const [helperAmounts, setHelperAmounts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (matterClients.length > 0 && selectedClientIds.length === 0) {
      const normalizedInitialIds = initialSelectedClientIds.filter((clientId) =>
        matterClients.some((client) => client.id === clientId),
      );
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initializes selection once async-fetched matter clients arrive
      setSelectedClientIds(
        normalizedInitialIds.length > 0
          ? normalizedInitialIds
          : matterClients.map((client) => client.id),
      );
    }
  }, [matterClients, initialSelectedClientIds, selectedClientIds.length]);

  const prevBaseNameRef = useRef(baseInvoiceName);

  useEffect(() => {
    const prevBase = prevBaseNameRef.current;
    const newBase = baseInvoiceName || "Invoice";
    setInvoiceConfigs((prev) => {
      const next = { ...prev };
      let counter = 0;
      for (const client of matterClients) {
        counter++;
        const clientLabel = client.name || client.email || client.id;
        if (!next[client.id]) {
          next[client.id] = {
            invoiceName: `${newBase} - ${clientLabel}`,
            invoiceNumber: baseInvoiceNumber ? `${baseInvoiceNumber}-${counter}` : "",
            billingEmail: client.email || "",
          };
        } else {
          // Update invoice name when baseInvoiceName changes
          const oldPrefix = `${prevBase || "Invoice"} - `;
          if (!next[client.id].invoiceName || next[client.id].invoiceName.startsWith(oldPrefix)) {
            next[client.id].invoiceName = `${newBase} - ${clientLabel}`;
          }
          if (!next[client.id].invoiceNumber && baseInvoiceNumber) {
            next[client.id].invoiceNumber = `${baseInvoiceNumber}-${counter}`;
          }
          if (!next[client.id].billingEmail && client.email) {
            next[client.id].billingEmail = client.email;
          }
        }
      }
      return next;
    });
    prevBaseNameRef.current = baseInvoiceName;
  }, [baseInvoiceName, baseInvoiceNumber, matterClients]);

  const selectedClients = useMemo(
    () => matterClients.filter((client) => selectedClientIds.includes(client.id)),
    [matterClients, selectedClientIds],
  );
  const matterClientNameById = useMemo(
    () =>
      new Map(
        matterClients.map((client) => [client.id, client.name || client.email || client.id]),
      ),
    [matterClients],
  );

  const totalSelectedAmount = useMemo(
    () => roundSplitValue(sourceRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0)),
    [sourceRows],
  );
  const sourceSignature = useMemo(
    () =>
      sourceRows
        .map((row) => `${buildRowKey(row)}:${Number(row.amount) || 0}:${row.sourceType === "time" ? Number(row.hours || 0) : 0}`)
        .join("|"),
    [sourceRows],
  );

  const applyDistribution = (weights: number[], nextMode: SplitBillingMode) => {
    if (selectedClients.length === 0) {
      onValidationError("Select at least one client to split the invoice.");
      return;
    }

    const nextAllocations: Record<string, Record<string, number>> = {};
    for (const row of sourceRows) {
      const amounts = distributeAmount(Number(row.amount) || 0, weights);
      nextAllocations[buildRowKey(row)] = selectedClients.reduce<Record<string, number>>((acc, client, index) => {
        acc[client.id] = amounts[index] || 0;
        return acc;
      }, {});
    }

    setAllocations(nextAllocations);
    setSplitMode(nextMode);
    onValidationError(null);
  };

  useEffect(() => {
    if (selectedClients.length === 0 || sourceRows.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- recomputes allocation distribution and notifies parent when selection or source changes
    applyDistribution(selectedClients.map(() => 1), "equal");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientIds.join("|"), sourceSignature]);

  const perClientSummaries = useMemo(() => {
    return selectedClients.map((client) => {
      let totalAmount = 0;
      let totalHours = 0;
      let flatFeesAmount = 0;

      for (const row of sourceRows) {
        const amount = allocations[buildRowKey(row)]?.[client.id] || 0;
        totalAmount += amount;
        if (row.sourceType === "time") {
          const rowAmount = Number(row.amount) || 0;
          const hours = rowAmount > 0 ? ((Number(row.hours) || 0) * amount) / rowAmount : 0;
          totalHours += hours;
        } else {
          flatFeesAmount += amount;
        }
      }

      return {
        client,
        totalAmount: roundSplitValue(totalAmount),
        totalHours: roundSplitValue(totalHours),
        flatFeesAmount: roundSplitValue(flatFeesAmount),
      };
    });
  }, [allocations, selectedClients, sourceRows]);

  const allocationIssues = useMemo(() => {
    if (selectedClients.length === 0) return ["Select at least one client."];

    const issues: string[] = [];
    for (const row of sourceRows) {
      const allocated = selectedClients.reduce((sum, client) => sum + (allocations[buildRowKey(row)]?.[client.id] || 0), 0);
      const remaining = roundSplitValue((Number(row.amount) || 0) - allocated);
      if (Math.abs(remaining) >= 0.01) {
        issues.push(`${row.sourceType === "time" ? row.name || row.description || "Time entry" : row.description} is ${remaining > 0 ? "under" : "over"} allocated.`);
      }
    }

    for (const summary of perClientSummaries) {
      if (summary.totalAmount <= 0) {
        issues.push(`${summary.client.name || summary.client.email || "Client"} has no invoice total.`);
      }
      const config = invoiceConfigs[summary.client.id];
      if (!config?.invoiceName?.trim()) {
        issues.push(`${summary.client.name || summary.client.email || "Client"} needs an invoice name.`);
      }
    }

    return Array.from(new Set(issues));
  }, [allocations, invoiceConfigs, perClientSummaries, selectedClients, sourceRows]);

  const toggleClient = (clientId: string) => {
    setSelectedClientIds((prev) =>
      prev.includes(clientId) ? prev.filter((id) => id !== clientId) : [...prev, clientId]
    );
  };

  const updateAllocation = (rowKey: string, clientId: string, value: string) => {
    const amount = roundSplitValue(Number(value) || 0);
    setAllocations((prev) => ({
      ...prev,
      [rowKey]: {
        ...(prev[rowKey] || {}),
        [clientId]: amount,
      },
    }));
    setSplitMode("manual");
  };

  const updateInvoiceConfig = (clientId: string, field: keyof SplitInvoiceConfig, value: string) => {
    setInvoiceConfigs((prev) => ({
      ...prev,
      [clientId]: {
        ...(prev[clientId] || { invoiceName: "", invoiceNumber: "", billingEmail: "" }),
        [field]: value,
      },
    }));
  };

  const allocateRowFully = (row: SplitSourceRow, clientId: string) => {
    const rowKey = buildRowKey(row);
    const totalAmount = roundSplitValue(Number(row.amount) || 0);
    const nextAllocations = selectedClients.reduce<Record<string, number>>((acc, client) => {
      acc[client.id] = client.id === clientId ? totalAmount : 0;
      return acc;
    }, {});

    setAllocations((prev) => ({
      ...prev,
      [rowKey]: nextAllocations,
    }));
    setSplitMode("manual");
    setPendingSplitMode("manual");
    setShowLineItems(true);
  };

  const allocateRowEqually = (row: SplitSourceRow) => {
    const rowKey = buildRowKey(row);
    const amounts = distributeAmount(
      Number(row.amount) || 0,
      selectedClients.map(() => 1),
    );

    setAllocations((prev) => ({
      ...prev,
      [rowKey]: selectedClients.reduce<Record<string, number>>((acc, client, index) => {
        acc[client.id] = amounts[index] || 0;
        return acc;
      }, {}),
    }));
    setSplitMode("manual");
    setPendingSplitMode("manual");
    setShowLineItems(true);
  };

  const applyPercentageSplit = () => {
    const weights = selectedClients.map((client) => Number(helperPercentages[client.id]) || 0);
    const totalPercent = roundSplitValue(weights.reduce((sum, value) => sum + value, 0));
    if (Math.abs(totalPercent - 100) >= 0.01) {
      onValidationError("Split percentages must total 100%.");
      return;
    }
    applyDistribution(weights, "percentage");
  };

  const applyFixedAmountSplit = () => {
    const weights = selectedClients.map((client) => Number(helperAmounts[client.id]) || 0);
    const total = roundSplitValue(weights.reduce((sum, value) => sum + value, 0));
    if (Math.abs(total - totalSelectedAmount) >= 0.01) {
      onValidationError(`Fixed split amounts must total ${formatCurrency(totalSelectedAmount)}.`);
      return;
    }
    applyDistribution(weights, "fixed_amount");
  };

  const resetAllocations = () => {
    const nextAllocations: Record<string, Record<string, number>> = {};
    for (const row of sourceRows) {
      nextAllocations[buildRowKey(row)] = selectedClients.reduce<Record<string, number>>((acc, client) => {
        acc[client.id] = 0;
        return acc;
      }, {});
    }
    setAllocations(nextAllocations);
    setSplitMode("manual");
  };

  const handleCreateSplitInvoices = async () => {
    if (allocationIssues.length > 0) {
      onValidationError(allocationIssues[0]);
      return;
    }

    setSaving(true);
    onValidationError(null);
    try {
      const rowPercentages = new Map<string, Map<string, number>>();
      const rowHours = new Map<string, Map<string, number>>();

      for (const row of sourceRows) {
        const rowKey = buildRowKey(row);
        const rowAmount = Number(row.amount) || 0;
        const clientAmounts = selectedClients.map((client) => allocations[rowKey]?.[client.id] || 0);
        const balancedPercentages = buildBalancedPercentagesFromAmounts(rowAmount, clientAmounts);

        rowPercentages.set(
          rowKey,
          selectedClients.reduce<Map<string, number>>((acc, client, index) => {
            acc.set(client.id, balancedPercentages[index] || 0);
            return acc;
          }, new Map()),
        );

        if (row.sourceType === "time") {
          const balancedHours = buildBalancedHoursFromAmounts(
            rowAmount,
            Number(row.hours) || 0,
            clientAmounts,
          );
          rowHours.set(
            rowKey,
            selectedClients.reduce<Map<string, number>>((acc, client, index) => {
              acc.set(client.id, balancedHours[index] || 0);
              return acc;
            }, new Map()),
          );
        }
      }

      const draftInvoices = selectedClients.map((client) => {
        const config = invoiceConfigs[client.id];
        const clientTimeEntries = timeEntries
          .map((entry) => {
            const rowKey = buildRowKey({ ...entry, sourceType: "time" });
            const allocationAmount = allocations[rowKey]?.[client.id] || 0;
            if (allocationAmount <= 0) return null;

            return {
              ...lineSourceId(entry.id),
              name: entry.name,
              description: entry.description,
              rate: entry.rate,
              hours: rowHours.get(rowKey)?.get(client.id) || 0,
              amount: allocationAmount,
              allocationPercent: rowPercentages.get(rowKey)?.get(client.id) || 0,
              allocationAmount,
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
        const clientFlatFees = flatFees
          .map((fee) => {
            const rowKey = buildRowKey({ ...fee, sourceType: "flat_fee" });
            const allocationAmount = allocations[rowKey]?.[client.id] || 0;
            if (allocationAmount <= 0) return null;

            return {
              ...lineSourceId(fee.id),
              description: fee.description,
              amount: allocationAmount,
              allocationPercent: rowPercentages.get(rowKey)?.get(client.id) || 0,
              allocationAmount,
            };
          })
          .filter((fee): fee is NonNullable<typeof fee> => fee !== null);

        const totalHours = roundSplitValue(
          clientTimeEntries.reduce((sum, entry) => sum + (Number(entry.hours) || 0), 0),
        );
        const flatFeesAmount = roundSplitValue(
          clientFlatFees.reduce((sum, fee) => sum + (Number(fee.amount) || 0), 0),
        );
        const timeEntriesAmount = roundSplitValue(
          clientTimeEntries.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0),
        );
        const totalAmount = roundSplitValue(timeEntriesAmount + flatFeesAmount);

        return {
          matterClientId: client.id,
          invoiceName: config.invoiceName.trim(),
          invoiceNumber: config.invoiceNumber.trim() || null,
          billingEmail: config.billingEmail.trim() || null,
          timeEntries: clientTimeEntries,
          flatFees: clientFlatFees,
          totalHours,
          totalAmount,
          flatFeesAmount,
          allocationAmount: totalAmount,
        };
      });
      const invoicePercentages = buildBalancedPercentagesFromAmounts(
        totalSelectedAmount,
        draftInvoices.map((invoice) => invoice.totalAmount),
      );

      const payload = {
        invoiceDate,
        dueDate: dueDate || null,
        notes: notes || null,
        remitTo: remitTo.name || remitTo.address ? remitTo : null,
        splitMode,
        sourceSelection: {
          timeEntries: timeEntries.filter((e) => !e.id.startsWith("manual-te-")).map((entry) => entry.id),
          flatFees: flatFees.filter((f) => !f.id.startsWith("flat-fee-")).map((fee) => fee.id),
        },
        invoices: draftInvoices.map((invoice, index) => ({
          ...invoice,
          allocationPercent: invoicePercentages[index] || 0,
        })),
      };

      const result = await billingService.createSplitInvoices(lawFirmId, matterId, payload);
      onCreated({ createdCount: result.createdCount, splitGroupId: result.splitGroupId });
    } catch (error) {
      onValidationError(error instanceof Error ? error.message : "Failed to create split invoices");
    } finally {
      setSaving(false);
    }
  };

  const [showLineItems, setShowLineItems] = useState(false);
  const [showAllClients, setShowAllClients] = useState(false);
  const [showAllSourceRows, setShowAllSourceRows] = useState(false);
  const [pendingSplitMode, setPendingSplitMode] = useState<"equal" | "percentage" | "fixed_amount" | "manual">("equal");

  const splitModeOptions = [
    { value: "equal" as const, label: "Equal Split", icon: Equal },
    { value: "percentage" as const, label: "By Percentage", icon: Percent },
    { value: "fixed_amount" as const, label: "By Amount", icon: DollarSign },
    { value: "manual" as const, label: "Per Entry", icon: SlidersHorizontal },
  ];

  const renderClientOption = (client: (typeof matterClients)[number]) => {
    const checked = selectedClientIds.includes(client.id);
    return (
      <label
        key={client.id}
        className={`flex items-center gap-3 rounded-lg border px-3 py-3 cursor-pointer transition-colors ${
          checked ? "border-accent-control-ring bg-blue-50/60 dark:bg-blue-950/20" : "border-outline hover:border-outline-subtle"
        }`}
      >
        <Checkbox
          checked={checked}
          onChange={() => toggleClient(client.id)}
        />
        <div className="min-w-0">
          <p className="text-sm font-medium text-on-surface truncate">{client.name || client.email || client.id}</p>
          {client.email ? <p className="text-xs text-on-surface-muted truncate">{client.email}</p> : null}
        </div>
      </label>
    );
  };

  const lineItemsExpanded = showLineItems || pendingSplitMode === "manual";

  return (
    <div className="space-y-5">
      {/* Section 1: Select Clients */}
      <div className="rounded-lg border border-outline p-4">
        <div className="flex items-center gap-2 mb-1">
          <Users size={15} className="text-on-surface-secondary" />
          <p className="text-sm font-semibold text-on-surface">Select Clients</p>
        </div>
        <p className="text-xs text-on-surface-muted mb-3">Choose which clients will receive a split invoice. Total: {formatCurrency(totalSelectedAmount)}</p>
        <CollapsibleList
          items={matterClients}
          previewLimit={LIST_PREVIEW_LIMIT}
          expanded={showAllClients}
          renderItem={renderClientOption}
          className="grid grid-cols-1 md:grid-cols-2 gap-3"
          overflowClassName="col-span-full"
        />
        <ShowMoreButton
          expanded={showAllClients}
          hiddenCount={matterClients.length - LIST_PREVIEW_LIMIT}
          onToggle={() => setShowAllClients(!showAllClients)}
        />
      </div>

      {selectedClients.length > 0 && (
        <>
          {/* Section 2: Split Method */}
          <div className="rounded-lg border border-outline p-4 space-y-4">
            <div>
              <p className="text-sm font-semibold text-on-surface mb-1">How to Split</p>
              <p className="text-xs text-on-surface-muted">Choose how {formatCurrency(totalSelectedAmount)} is divided among {selectedClients.length} {selectedClients.length === 1 ? "client" : "clients"}</p>
            </div>

            <SegmentedToggle
              ariaLabel="Split method"
              value={pendingSplitMode}
              onChange={(mode) => {
                setPendingSplitMode(mode);
                if (mode === "equal") {
                  applyDistribution(selectedClients.map(() => 1), "equal");
                } else if (mode === "manual") {
                  setSplitMode("manual");
                  setShowLineItems(true);
                }
              }}
              options={splitModeOptions}
            />

            {/* Mode-specific inputs */}
            {pendingSplitMode === "equal" && (
              <div className="rounded-lg bg-surface-alt border border-outline-subtle p-3">
                <p className="text-xs text-on-surface-secondary">
                  Each client receives <span className="font-semibold text-on-surface">{formatCurrency(roundSplitValue(totalSelectedAmount / selectedClients.length))}</span> ({roundSplitValue(100 / selectedClients.length).toFixed(1)}% each)
                </p>
              </div>
            )}

            {pendingSplitMode === "percentage" && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {selectedClients.map((client) => {
                    const pct = Number(helperPercentages[client.id]) || 0;
                    const previewAmount = roundSplitValue((totalSelectedAmount * pct) / 100);
                    return (
                      <div key={client.id} className="rounded-lg border border-outline-subtle bg-surface-alt p-3">
                        <p className="text-xs font-medium text-on-surface mb-1.5">{client.name || client.email || client.id}</p>
                        <div className="flex items-center gap-2">
                          <div className="relative flex-1">
                            <input
                              type="number"
                              min="0"
                              max="100"
                              step="0.01"
                              value={helperPercentages[client.id] || ""}
                              onChange={(event) =>
                                setHelperPercentages((prev) => ({ ...prev, [client.id]: event.target.value }))
                              }
                              placeholder="0"
                              className="w-full rounded-md border border-input-border bg-input-bg px-3 py-2 pr-8 text-sm text-on-surface"
                            />
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-on-surface-muted">%</span>
                          </div>
                          <span className="text-xs text-on-surface-muted whitespace-nowrap">= {formatCurrency(previewAmount)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {(() => {
                  const totalPct = roundSplitValue(selectedClients.reduce((sum, c) => sum + (Number(helperPercentages[c.id]) || 0), 0));
                  return (
                    <div className="flex items-center justify-between">
                      <p className={`text-xs ${Math.abs(totalPct - 100) < 0.01 ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>
                        Total: {totalPct.toFixed(1)}%{Math.abs(totalPct - 100) >= 0.01 ? " (must equal 100%)" : ""}
                      </p>
                      <Button type="secondary" onClick={applyPercentageSplit}>
                        Apply Split
                      </Button>
                    </div>
                  );
                })()}
              </div>
            )}

            {pendingSplitMode === "fixed_amount" && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {selectedClients.map((client) => {
                    const amt = Number(helperAmounts[client.id]) || 0;
                    const pctOfTotal = totalSelectedAmount > 0 ? roundSplitValue((amt / totalSelectedAmount) * 100) : 0;
                    return (
                      <div key={client.id} className="rounded-lg border border-outline-subtle bg-surface-alt p-3">
                        <p className="text-xs font-medium text-on-surface mb-1.5">{client.name || client.email || client.id}</p>
                        <div className="flex items-center gap-2">
                          <div className="relative flex-1">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-on-surface-muted">$</span>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={helperAmounts[client.id] || ""}
                              onChange={(event) =>
                                setHelperAmounts((prev) => ({ ...prev, [client.id]: event.target.value }))
                              }
                              placeholder="0.00"
                              className={`${INPUT_CLS} w-full pl-7`}
                            />
                          </div>
                          <span className="text-xs text-on-surface-muted whitespace-nowrap">({pctOfTotal.toFixed(1)}%)</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {(() => {
                  const totalAmt = roundSplitValue(selectedClients.reduce((sum, c) => sum + (Number(helperAmounts[c.id]) || 0), 0));
                  const diff = roundSplitValue(totalSelectedAmount - totalAmt);
                  return (
                    <div className="flex items-center justify-between">
                      <p className={`text-xs ${Math.abs(diff) < 0.01 ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>
                        Total: {formatCurrency(totalAmt)} of {formatCurrency(totalSelectedAmount)}
                        {Math.abs(diff) >= 0.01 ? ` (${diff > 0 ? `${formatCurrency(diff)} remaining` : `${formatCurrency(Math.abs(diff))} over`})` : ""}
                      </p>
                      <Button type="secondary" onClick={applyFixedAmountSplit}>
                        Apply Split
                      </Button>
                    </div>
                  );
                })()}
              </div>
            )}

            {pendingSplitMode === "manual" && (
              <div className="rounded-lg bg-surface-alt border border-outline-subtle p-3 space-y-2">
                <p className="text-xs font-medium text-on-surface">Mix full assignments and shared splits</p>
                <p className="text-xs text-on-surface-secondary">
                  Use the entry-by-entry table below to send one time entry fully to a single client, while splitting other entries across multiple clients.
                </p>
                <p className="text-xs text-on-surface-muted">
                  Tip: use the quick actions on each row for 100% to one client or equal split, then fine-tune amounts if needed.
                </p>
              </div>
            )}
          </div>

          {/* Section 3: Split Preview */}
          <div className="rounded-lg border border-outline p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-on-surface">Split Preview</p>
                <p className="text-xs text-on-surface-muted">How each client&apos;s invoice will look</p>
              </div>
              <button
                onClick={resetAllocations}
                className="text-xs text-on-surface-muted hover:text-on-surface transition-colors cursor-pointer"
              >
                Reset all
              </button>
            </div>

            {/* Visual share bars */}
            <div className="space-y-2">
              {perClientSummaries.map((summary) => {
                const sharePercent = totalSelectedAmount > 0 ? (summary.totalAmount / totalSelectedAmount) * 100 : 0;
                return (
                  <div key={summary.client.id} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-on-surface">{summary.client.name || summary.client.email || summary.client.id}</span>
                      <span className="text-on-surface-secondary">
                        {formatCurrency(summary.totalAmount)} <span className="text-on-surface-muted">({sharePercent.toFixed(1)}%)</span>
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-surface-alt overflow-hidden">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-all duration-300"
                        style={{ width: `${Math.min(sharePercent, 100)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Expandable line-item detail */}
            <button
              onClick={() => setShowLineItems(!showLineItems)}
              className="flex items-center gap-1 text-xs text-accent-emphasis hover:underline cursor-pointer"
            >
              {lineItemsExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              {lineItemsExpanded ? "Hide" : "Show"} line-item breakdown
            </button>

            {lineItemsExpanded && (
              <div className="overflow-x-auto rounded-lg border border-outline">
                <table className="min-w-full divide-y divide-outline text-sm">
                  <thead className="bg-surface-alt">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-on-surface-secondary">Item</th>
                      <th className="px-3 py-2 text-right font-medium text-on-surface-secondary">Total</th>
                      {selectedClients.map((client) => (
                        <th key={client.id} className="px-3 py-2 text-right font-medium text-on-surface-secondary">
                          {client.name || client.email || client.id}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline">
                    {(showAllSourceRows ? sourceRows : sourceRows.slice(0, LIST_PREVIEW_LIMIT)).map((row) => {
                      const rowKey = buildRowKey(row);
                      const allocated = selectedClients.reduce((sum, client) => sum + (allocations[rowKey]?.[client.id] || 0), 0);
                      const remaining = roundSplitValue((Number(row.amount) || 0) - allocated);
                      const preferredClientNames =
                        row.sourceType === "time"
                          ? ((row.matterClientIds?.length ? row.matterClientIds : row.matterClientId ? [row.matterClientId] : [])
                              .map((matterClientId) => matterClientNameById.get(matterClientId) || null)
                              .filter((value): value is string => Boolean(value)))
                          : [];
                      const preferredClientLabel =
                        preferredClientNames.length === 0
                          ? null
                          : preferredClientNames.length === 1
                            ? `Preferred client: ${preferredClientNames[0]}`
                            : `Preferred clients: ${preferredClientNames.join(", ")}`;
                      return (
                        <tr key={rowKey}>
                          <td className="px-3 py-3 align-top">
                            <p className="font-medium text-on-surface">
                              {row.sourceType === "time" ? row.name || row.description || "Time entry" : row.description}
                            </p>
                            {row.sourceType === "time" && row.name && row.description ? (
                              <p className="mt-1 text-xs text-on-surface-secondary">
                                {row.description}
                              </p>
                            ) : null}
                            <p className="text-xs text-on-surface-muted">
                              {row.sourceType === "time" ? formatHoursMinutes(row.hours || 0) : "Flat fee"}
                              {Math.abs(remaining) >= 0.01 ? (
                                <span className={remaining > 0 ? "text-amber-500" : "text-red-500"}> &middot; {remaining > 0 ? "Unallocated" : "Over by"} {formatCurrency(Math.abs(remaining))}</span>
                              ) : null}
                            </p>
                            {preferredClientLabel ? (
                              <p className="mt-1">
                                <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                                  {preferredClientLabel}
                                </span>
                              </p>
                            ) : null}
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                onClick={() => allocateRowEqually(row)}
                                className="rounded-full border border-outline px-2 py-0.5 text-[11px] text-on-surface-secondary transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:text-on-surface hover:bg-surface-hover cursor-pointer"
                              >
                                Split equally
                              </button>
                              {selectedClients.map((client) => (
                                <button
                                  key={client.id}
                                  type="button"
                                  onClick={() => allocateRowFully(row, client.id)}
                                  className="rounded-full border border-outline px-2 py-0.5 text-[11px] text-on-surface-secondary transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:text-on-surface hover:bg-surface-hover cursor-pointer"
                                >
                                  100% to {client.name || client.email || client.id}
                                </button>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-right font-medium text-on-surface">
                            {formatCurrency(Number(row.amount) || 0)}
                          </td>
                          {selectedClients.map((client) => (
                            <td key={client.id} className="px-3 py-3 text-right">
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={allocations[rowKey]?.[client.id] ?? ""}
                                onChange={(event) => updateAllocation(rowKey, client.id, event.target.value)}
                                className="w-28 rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface text-right"
                              />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <ShowMoreButton
                  expanded={showAllSourceRows}
                  hiddenCount={sourceRows.length - LIST_PREVIEW_LIMIT}
                  onToggle={() => setShowAllSourceRows(!showAllSourceRows)}
                  className="border-t border-outline"
                />
              </div>
            )}
          </div>

          {/* Section 4: Invoice Details per Client */}
          <div className="space-y-3">
            <p className="text-sm font-semibold text-on-surface">Invoice Details</p>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {perClientSummaries.map((summary, index) => {
                const config = invoiceConfigs[summary.client.id] || { invoiceName: "", invoiceNumber: "", billingEmail: "" };
                return (
                  <div key={summary.client.id} className="rounded-lg border border-outline p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-on-surface">{summary.client.name || summary.client.email || summary.client.id}</p>
                        <p className="text-xs text-on-surface-muted">
                          {formatHoursMinutes(summary.totalHours)} &middot; {formatCurrency(summary.totalAmount)}
                        </p>
                      </div>
                      <span className="text-xs bg-surface-alt text-on-surface-muted px-2 py-0.5 rounded-full">Invoice {index + 1}</span>
                    </div>
                    <div className="space-y-2">
                      <div>
                        <FieldLabel htmlFor={`${fieldIds}-invoice-name`} size="xs" tone="secondary">Invoice Name *</FieldLabel>
                        <input
                          id={`${fieldIds}-invoice-name`}
                          type="text"
                          value={config.invoiceName}
                          onChange={(event) => updateInvoiceConfig(summary.client.id, "invoiceName", event.target.value)}
                          placeholder="Invoice name"
                          className="w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface"
                        />
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <div>
                          <FieldLabel htmlFor={`${fieldIds}-invoice-number`} size="xs" tone="secondary">Invoice Number</FieldLabel>
                          <input
                            id={`${fieldIds}-invoice-number`}
                            type="text"
                            value={config.invoiceNumber}
                            onChange={(event) => updateInvoiceConfig(summary.client.id, "invoiceNumber", event.target.value)}
                            placeholder="Optional"
                            className="w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface"
                          />
                        </div>
                        <div>
                          <FieldLabel htmlFor={`${fieldIds}-billing-email`} size="xs" tone="secondary">Billing Email</FieldLabel>
                          <input
                            id={`${fieldIds}-billing-email`}
                            type="email"
                            value={config.billingEmail}
                            onChange={(event) => updateInvoiceConfig(summary.client.id, "billingEmail", event.target.value)}
                            placeholder="Optional"
                            className="w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface"
                          />
                          <p className="text-[11px] text-on-surface-muted mt-1">Used when sending the invoice. No email is sent on create.</p>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section 5: Create button */}
          <div className="rounded-lg border border-outline p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-medium text-on-surface">
                {selectedClients.length} {selectedClients.length === 1 ? "invoice" : "invoices"} totaling {formatCurrency(totalSelectedAmount)}
              </p>
              {allocationIssues.length > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">{allocationIssues[0]}</p>
              )}
            </div>
            <Button
              type="primary"
              onClick={handleCreateSplitInvoices}
              loading={saving}
              disabled={sourceRows.length === 0 || selectedClients.length === 0}
            >
              Create Split Invoices
            </Button>
          </div>
        </>
      )}

      {selectedClients.length === 0 && (
        <div className="rounded-lg border border-dashed border-outline p-6 text-center">
          <Users size={32} className="mx-auto text-on-surface-muted mb-2" />
          <p className="text-sm text-on-surface-secondary">Select at least one client above to split this invoice</p>
        </div>
      )}
    </div>
  );
}
