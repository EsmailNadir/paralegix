"use client";

import { Briefcase, Pencil } from "lucide-react";
import { useNavigation } from "@/contexts/NavigationContext";
import type { Matter } from "@/types/matter";
import MatterStatusBadge from "@/components/ui/MatterStatusBadge";
import EntityListTab from "@/components/ui/EntityListTab";
import ActionIconButton from "@/components/ui/ActionIconButton";
import { highlightText } from "@/components/ui/HighlightText";

export interface EntityMattersTabProps {
  lawFirmId: string;
  matters: Matter[];
  canManageMatters?: boolean;
  onCreateMatterClick?: () => void;
  onEditMatter?: (matter: Matter) => void;
  emptyTitle?: string;
  emptyMessage?: string;
}

const BILLING_METHOD_LABELS: Record<string, string> = {
  hourly: "Hourly",
  flat: "Flat Fee",
  contingency: "Contingency",
  pro_bono: "Pro Bono",
};

export default function EntityMattersTab({
  lawFirmId,
  matters,
  canManageMatters = false,
  onCreateMatterClick,
  onEditMatter,
  emptyTitle = "No matters found",
  emptyMessage = "There are no matters associated with this entity yet.",
}: EntityMattersTabProps) {
  const { navigate } = useNavigation();

  return (
    <EntityListTab<Matter>
      rows={matters}
      getRowId={(matter) => matter.id}
      onRowClick={(matter) => {
        if (matter.id) {
          navigate(`/lawfirm/${lawFirmId}/matters/${matter.id}`);
        }
      }}
      searchPlaceholder="Search matters..."
      matchesSearch={(matter, term) =>
        (matter.name || "").toLowerCase().includes(term) ||
        Boolean(matter.matterNumber?.toLowerCase().includes(term)) ||
        Boolean(matter.practiceAreaName?.toLowerCase().includes(term))
      }
      statusOptions={[
        { value: "all", label: `All Matters (${matters.length})` },
        { value: "open", label: "Open / Active" },
        { value: "closed", label: "Closed" },
        { value: "pending", label: "Pending" },
      ]}
      // "Open" covers the `active` status, which is what the column is called.
      matchesStatus={(matter, status) =>
        status === "open" ? matter.status === "active" : matter.status === status
      }
      create={
        canManageMatters && onCreateMatterClick
          ? { label: "New Matter", onClick: onCreateMatterClick }
          : undefined
      }
      renderRow={(matter, searchTerm) => ({
        title: (
          <span className="flex items-center gap-2 font-medium text-on-surface">
            <Briefcase size={15} className="text-accent-emphasis shrink-0" />
            {highlightText(matter.name || "Unnamed Matter", searchTerm)}
            {matter.matterNumber && (
              <span className="text-xs text-on-surface-muted font-normal">
                (#{highlightText(matter.matterNumber, searchTerm)})
              </span>
            )}
          </span>
        ),
        badges: matter.status ? <MatterStatusBadge status={matter.status} /> : undefined,
        meta: highlightText(
          [
            matter.practiceAreaName,
            matter.billingMethod ? BILLING_METHOD_LABELS[matter.billingMethod] || matter.billingMethod : null,
            matter.leadUserName ? `Lead: ${matter.leadUserName}` : null,
          ]
            .filter(Boolean)
            .join("  ·  "),
          searchTerm
        ),
      })}
      rowActions={
        canManageMatters && onEditMatter
          ? (matter) => (
              <ActionIconButton
                label={`Edit ${matter.name || "matter"}`}
                tooltip="Edit"
                tone="info"
                onClick={(e) => {
                  e.stopPropagation();
                  onEditMatter(matter);
                }}
              >
                <Pencil size={15} />
              </ActionIconButton>
            )
          : undefined
      }
      emptyIcon={<Briefcase size={36} />}
      emptyTitle={emptyTitle}
      emptyMessage={emptyMessage}
      noMatchTitle="No matching matters"
    />
  );
}
