"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useNavigation } from "@/contexts/NavigationContext";
import {
  Users,
  Building2,
  ChevronRight,
  UserRound,
  Trash2,
  Pencil,
  Plus,
} from "lucide-react";
import ListView from "@/components/ui/ListView";
import ActionIconButton from "@/components/ui/ActionIconButton";
import StatusBadge from "@/components/ui/StatusBadge";
import { highlightText } from "@/components/ui/HighlightText";
import Tooltip from "@/components/ui/Tooltip";
import Spinner from "@/components/ui/Spinner";
import ErrorNotification from "@/components/ErrorNotification";
import ClientsService from "@/services/clients.service";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { isCompanyRosterContact, type CompanyRosterContact } from "@/types/client";
import Button from "@/components/ui/Button";
import SearchInput from "@/components/ui/SearchInput";

export interface EntityClientItem {
  id: string;
  name: string;
  clientType?: "person" | "company";
  email?: string | null;
  phone?: string | null;
  organization?: string | null;
  userId?: string | null;
  portalInvitePending?: boolean;
  canonicalClientId?: string;
}

interface CompanyRosterState {
  contacts: CompanyRosterContact[];
  loading: boolean;
  error: string | null;
}

interface EntityClientsTabProps {
  lawFirmId: string;
  clients: EntityClientItem[];
  canManageClients?: boolean;
  onAddClientClick?: () => void;
  onRemoveClient?: (client: { id: string; name: string }) => void;
  onEditClient?: (client: EntityClientItem) => void;
  inheritedBanner?: React.ReactNode;
  showSearch?: boolean;
  emptyTitle?: string;
  emptyMessage?: string;
}

export default function EntityClientsTab({
  lawFirmId,
  clients,
  canManageClients = false,
  onAddClientClick,
  onRemoveClient,
  onEditClient,
  inheritedBanner,
  showSearch = false,
  emptyTitle = "No clients added yet",
  emptyMessage = "Add a client to keep track of who this is for.",
}: EntityClientsTabProps) {
  const { navigate } = useNavigation();
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedCompanyClientId, setExpandedCompanyClientId] = useState<string | null>(null);
  const [companyRosters, setCompanyRosters] = useState<Record<string, CompanyRosterState>>({});
  const initializedClientExpansion = useRef(false);

  const loadCompanyRoster = useCallback(
    async (companyClientId: string) => {
      setCompanyRosters((current) => {
        const existing = current[companyClientId];
        if (existing?.contacts && existing.contacts.length > 0) {
          return current;
        }
        return {
          ...current,
          [companyClientId]: {
            contacts: existing?.contacts || [],
            loading: true,
            error: null,
          },
        };
      });

      try {
        const contacts = await ClientsService.listClientContacts(lawFirmId, companyClientId);
        setCompanyRosters((current) => ({
          ...current,
          [companyClientId]: {
            contacts: contacts.filter(isCompanyRosterContact),
            loading: false,
            error: null,
          },
        }));
      } catch (err) {
        setCompanyRosters((current) => ({
          ...current,
          [companyClientId]: {
            contacts: current[companyClientId]?.contacts || [],
            loading: false,
            error: getErrorMessage(err, "Failed to load linked clients"),
          },
        }));
      }
    },
    [lawFirmId]
  );

  // Auto-expand first company client on initial load
  useEffect(() => {
    for (const client of clients) {
      if (client.clientType === "company") {
        void loadCompanyRoster(client.id);
      }
    }

    if (!initializedClientExpansion.current) {
      const firstCompany = clients.find((c) => c.clientType === "company");
      if (firstCompany) {
        initializedClientExpansion.current = true;
        setExpandedCompanyClientId(firstCompany.id);
      }
    }
  }, [clients, loadCompanyRoster]);

  // Collect company names for roster filtering
  const attachedCompanyNames = useMemo(() => {
    const names = new Set<string>();
    for (const client of clients) {
      if (client.clientType === "company" && client.name?.trim()) {
        names.add(client.name.trim().toLowerCase());
      }
    }
    return names;
  }, [clients]);

  // Collect roster person IDs across attached company clients
  const attachedCompanyRosterPersonIds = useMemo(() => {
    const ids = new Set<string>();
    for (const client of clients) {
      if (client.clientType === "company") {
        const roster = companyRosters[client.id];
        if (roster?.contacts) {
          for (const contact of roster.contacts) {
            if (contact.personClientId) {
              ids.add(contact.personClientId);
            }
          }
        }
      }
    }
    return ids;
  }, [clients, companyRosters]);

  // Filter out standalone person clients whose company is attached
  const filteredClients = useMemo(() => {
    return clients.filter((client) => {
      if (client.clientType !== "company") {
        const matchesCompanyByName = Boolean(
          client.organization?.trim() &&
            attachedCompanyNames.has(client.organization.trim().toLowerCase())
        );
        const matchesCompanyByRosterId = attachedCompanyRosterPersonIds.has(client.id);

        if (matchesCompanyByName || matchesCompanyByRosterId) {
          return false;
        }
      }

      if (showSearch && searchTerm.trim()) {
        const term = searchTerm.trim().toLowerCase();
        const nameMatch = (client.name || "").toLowerCase().includes(term);
        const emailMatch = (client.email || "").toLowerCase().includes(term);
        const orgMatch = (client.organization || "").toLowerCase().includes(term);
        return nameMatch || emailMatch || orgMatch;
      }

      return true;
    });
  }, [clients, attachedCompanyNames, attachedCompanyRosterPersonIds, showSearch, searchTerm]);

  const handleRowClick = useCallback(
    (client: EntityClientItem) => {
      if (client.clientType !== "company") {
        const targetId = client.canonicalClientId || client.id;
        navigate(`/lawfirm/${lawFirmId}/clients/${targetId}`);
        return;
      }

      const opening = expandedCompanyClientId !== client.id;
      setExpandedCompanyClientId(opening ? client.id : null);
      if (opening && !companyRosters[client.id]) {
        void loadCompanyRoster(client.id);
      }
    },
    [companyRosters, expandedCompanyClientId, lawFirmId, loadCompanyRoster, navigate]
  );

  const renderRow = useCallback(
    (client: EntityClientItem) => {
      const isCompany = client.clientType === "company";
      const expanded = isCompany && expandedCompanyClientId === client.id;
      const roster = companyRosters[client.id];
      const rosterContacts = roster?.contacts || [];

      return {
        title: (
          <span className="flex items-center gap-1.5">
            {isCompany && (
              <ChevronRight
                size={15}
                className={`shrink-0 text-on-surface-muted transition-transform duration-200 motion-reduce:transition-none ${
                  expanded ? "rotate-90" : ""
                }`}
              />
            )}
            {isCompany && (
              <Tooltip title="Company client" enterDelay={300}>
                <Building2 size={14} className="text-accent-emphasis shrink-0" />
              </Tooltip>
            )}
            {highlightText(client.name || "Unnamed Client", searchTerm)}
          </span>
        ),
        badges: client.userId ? (
          <StatusBadge variant="success">Portal account</StatusBadge>
        ) : client.portalInvitePending ? (
          <StatusBadge variant="warning">Portal invite pending</StatusBadge>
        ) : undefined,
        meta: highlightText(
          [
            client.organization,
            client.email,
            client.phone,
            isCompany && roster && !roster.loading && !roster.error && rosterContacts.length > 0
              ? `${rosterContacts.length} linked ${rosterContacts.length === 1 ? "client" : "clients"}`
              : null,
          ]
            .filter(Boolean)
            .join("  ·  "),
          searchTerm
        ),
        detailsOpen: expanded,
        detailsId: `company-roster-${client.id}`,
        details: isCompany ? (
          <div className="border-t border-outline-subtle bg-surface-alt/40 px-4 py-3">
            {roster?.loading ? (
              <div className="flex items-center gap-2 text-xs text-on-surface-muted">
                <Spinner size={14} />
                Loading linked clients…
              </div>
            ) : roster?.error ? (
              <ErrorNotification
                error={roster.error}
                compact
                onRetry={() => void loadCompanyRoster(client.id)}
                retrying={roster.loading}
              />
            ) : rosterContacts.length ? (
              <div className="space-y-1.5">
                {[...rosterContacts]
                  .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary))
                  .map((contact) => (
                    <button
                      key={contact.id}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/lawfirm/${lawFirmId}/clients/${contact.personClientId}`);
                      }}
                      className="flex w-full items-start gap-3 rounded-lg border border-outline-subtle bg-surface-alt px-3 py-2.5 text-left transition-colors hover:bg-surface-hover cursor-pointer"
                    >
                      <UserRound size={15} className="shrink-0 text-on-surface-muted mt-0.5" />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-xs font-medium text-on-surface">
                            {contact.name || "Unnamed Client"}
                          </span>
                          {contact.isPrimary && <StatusBadge variant="info">Primary</StatusBadge>}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-on-surface-muted">
                          {contact.relationship && <span>{contact.relationship}</span>}
                          {contact.email && <span>{contact.email}</span>}
                          {contact.phone && <span>{contact.phone}</span>}
                        </span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <Tooltip
                            title={
                              contact.userId
                                ? "Active client portal account"
                                : contact.portalInvitePending
                                ? "Portal invitation pending acceptance"
                                : "This member does not have a client portal account yet"
                            }
                            enterDelay={300}
                          >
                            <span>
                              <StatusBadge
                                variant={
                                  contact.userId
                                    ? "success"
                                    : contact.portalInvitePending
                                    ? "warning"
                                    : "neutral"
                                }
                              >
                                {contact.userId
                                  ? "Portal account"
                                  : contact.portalInvitePending
                                  ? "Portal invite pending"
                                  : "No portal account"}
                              </StatusBadge>
                            </span>
                          </Tooltip>
                          <Tooltip
                            title={
                              contact.isEmailRecipient
                                ? contact.email
                                  ? "Invoices, reminders, and payment receipts will be emailed to this person"
                                  : "No email address added: emails cannot be delivered until an email address is added"
                                : "This member is not set to receive billing emails"
                            }
                            enterDelay={300}
                          >
                            <span>
                              <StatusBadge
                                variant={
                                  contact.isEmailRecipient
                                    ? contact.email
                                      ? "success"
                                      : "warning"
                                    : "neutral"
                                }
                              >
                                {contact.isEmailRecipient
                                  ? contact.email
                                    ? "Receives emails"
                                    : "Receives emails (No Email)"
                                  : "No email delivery"}
                              </StatusBadge>
                            </span>
                          </Tooltip>
                          {contact.canViewBilling && (
                            <Tooltip
                              title="Allows viewing organization invoices in the client portal"
                              enterDelay={300}
                            >
                              <span>
                                <StatusBadge variant="info">Billing portal access</StatusBadge>
                              </span>
                            </Tooltip>
                          )}
                        </span>
                      </span>
                      <ChevronRight size={14} className="shrink-0 text-on-surface-muted mt-0.5" />
                    </button>
                  ))}
              </div>
            ) : (
              <p className="text-xs text-on-surface-muted">
                {roster?.contacts.length
                  ? "This company's linked clients are already shown above."
                  : "No clients are linked to this company."}
              </p>
            )}
          </div>
        ) : undefined,
      };
    },
    [companyRosters, expandedCompanyClientId, lawFirmId, loadCompanyRoster, navigate, searchTerm]
  );

  return (
    <div>
      {inheritedBanner}

      {/* Same toolbar row as the matters and tasks tabs: search on the left, the
          action on the right. */}
      {(!inheritedBanner || (showSearch && clients.length > 5)) && (
        <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {showSearch && clients.length > 5 && (
              <SearchInput
                className="min-w-[200px] max-w-md flex-1"
                placeholder="Search clients..."
                aria-label="Search clients"
                value={searchTerm}
                onChange={setSearchTerm}
              />
            )}
            {!inheritedBanner && (
              <h3 className="text-sm font-medium text-on-surface-secondary">
                {filteredClients.length} client{filteredClients.length !== 1 ? "s" : ""}
              </h3>
            )}
          </div>
          {!inheritedBanner && canManageClients && onAddClientClick && (
            <Button
              size="compact"
              onClick={onAddClientClick}
              icon={<Plus size={14} strokeWidth={2.2} />}
            >
              Add Client
            </Button>
          )}
        </div>
      )}

      <ListView
        variant="separated"
        rows={filteredClients}
        getRowId={(client) => client.id}
        onRowClick={handleRowClick}
        renderRow={renderRow}
        rowActions={
          canManageClients && (onEditClient || onRemoveClient)
            ? (client) => (
                <>
                  {onEditClient && (
                    <ActionIconButton
                      label={`Edit ${client.name || "client"}`}
                      tooltip="Edit"
                      tone="info"
                      onClick={() => onEditClient(client)}
                    >
                      <Pencil size={15} />
                    </ActionIconButton>
                  )}
                  {onRemoveClient && (
                    <ActionIconButton
                      label={`Remove ${client.name || "client"}`}
                      tooltip="Remove"
                      tone="danger"
                      onClick={() => onRemoveClient({ id: client.id, name: client.name })}
                    >
                      <Trash2 size={15} />
                    </ActionIconButton>
                  )}
                </>
              )
            : undefined
        }
        emptyIcon={<Users size={36} />}
        emptyTitle={searchTerm ? "No clients match your search" : emptyTitle}
        emptyMessage={searchTerm ? "Try a different search term." : emptyMessage}
      />
    </div>
  );
}
