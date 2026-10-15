import { Plus, User, Trash2, Pencil } from "lucide-react";
import ListView from "@/components/ui/ListView";
import ActionIconButton from "@/components/ui/ActionIconButton";
import StatusBadge from "@/components/ui/StatusBadge";
import Button from "@/components/ui/Button";

export interface TeamMemberItem {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  hourlyRate?: number | null;
  isLead?: boolean;
}

export interface EntityTeamSectionProps {
  members: TeamMemberItem[];
  canManageTeam?: boolean;
  onAddMemberClick?: () => void;
  onRemoveMember?: (member: TeamMemberItem) => void;
  onEditMemberRate?: (member: TeamMemberItem) => void;
  emptyTitle?: string;
  emptyMessage?: string;
}

export default function EntityTeamSection({
  members,
  canManageTeam = false,
  onAddMemberClick,
  onRemoveMember,
  onEditMemberRate,
  emptyTitle = "No team members assigned",
  emptyMessage = "Add firm members to give them access to this entity.",
}: EntityTeamSectionProps) {
  return (
    <div className="space-y-4">
      {/* Header Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-semibold text-on-surface">Team Members</h3>
          <p className="text-sm text-on-surface-secondary">
            {members.length} member{members.length !== 1 ? "s" : ""} assigned to this entity.
          </p>
        </div>

        {canManageTeam && onAddMemberClick && (
          <Button
            size="compact"
            onClick={onAddMemberClick}
            icon={<Plus size={14} strokeWidth={2.2} />}
          >
            Add Member
          </Button>
        )}
      </div>

      {/* Members List */}
      <ListView
        variant="separated"
        rows={members}
        getRowId={(member) => member.id}
        renderRow={(member) => ({
          title: (
            <span className="flex items-center gap-2 font-medium text-on-surface">
              <User size={15} className="text-on-surface-muted shrink-0" />
              {member.name || member.email || "Unnamed Member"}
            </span>
          ),
          badges: (
            <div className="flex items-center gap-1.5">
              {member.isLead && <StatusBadge variant="info">Lead Attorney</StatusBadge>}
              {member.role && !member.isLead && (
                <StatusBadge variant="neutral">
                  {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
                </StatusBadge>
              )}
            </div>
          ),
          meta: [
            member.email,
            member.hourlyRate !== undefined && member.hourlyRate !== null
              ? `$${member.hourlyRate}/hr`
              : null,
          ]
            .filter(Boolean)
            .join("  ·  "),
        })}
        rowActions={
          canManageTeam
            ? (member) => (
                <div className="flex items-center gap-1">
                  {onEditMemberRate && (
                    <ActionIconButton
                      label={`Edit rate for ${member.name || "member"}`}
                      tooltip="Edit Rate"
                      tone="info"
                      onClick={() => onEditMemberRate(member)}
                    >
                      <Pencil size={15} />
                    </ActionIconButton>
                  )}
                  {onRemoveMember && (
                    <ActionIconButton
                      label={`Remove ${member.name || "member"}`}
                      tooltip="Remove"
                      tone="danger"
                      onClick={() => onRemoveMember(member)}
                    >
                      <Trash2 size={15} />
                    </ActionIconButton>
                  )}
                </div>
              )
            : undefined
        }
        emptyIcon={<User size={40} />}
        emptyTitle={emptyTitle}
        emptyMessage={emptyMessage}
      />
    </div>
  );
}
