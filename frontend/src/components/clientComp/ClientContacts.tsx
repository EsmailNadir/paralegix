"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clientsService from "@/services/clients.service";
import Button from "@/components/ui/Button";
import ErrorNotification from "@/components/ErrorNotification";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { isCompanyRosterContact, isPersonRelatedContact, type ClientContact, type ClientContactPortalStatus, type ClientType, type CompanyRosterContact } from "@/types";
import { Mail, Phone, UserRound, Star, Trash2, Pencil, ExternalLink, Building2, Plus, DollarSign, Eye, EyeOff, AlertTriangle } from "lucide-react";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import StatusBadge from "@/components/ui/StatusBadge";
import Tooltip from "@/components/ui/Tooltip";
import { AutoPager } from "@/components/ui/ListPager";
import usePagedRows from "@/hooks/usePagedRows";
import ListEmptyState from "@/components/ui/ListEmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { clientPortalStatusMeta } from "@/constants/statusMeta";
import ClientContactModal from "./ClientContactModal";

type Props = {
  lawFirmId: string;
  clientId: string;
  /**
   * A PERSON client's own related contacts (guardians, assistants, etc.) and
   * a COMPANY client's roster of linked Person clients are different
   * features sharing this one tab. Absent/'person' renders the former.
   */
  clientType?: ClientType;
};

/**
 * A roster link's portal status, derived from `userId`/`portalInvitePending`.
 * The backend exposes no separate "revoked" flag: a link that once had access
 * and lost it looks identical to one that was never invited, so this only
 * ever resolves to one of the three states `clientPortalStatusMeta` already
 * knows (linked/pending/none) - the same vocabulary the admin console uses
 * for a person client's own portal status, since a company-linked person's
 * portal identity now IS their own client portal status.
 */
function rosterPortalStatus(contact: CompanyRosterContact): ClientContactPortalStatus {
  if (contact.userId) return "linked";
  if (contact.portalInvitePending) return "pending";
  return "none";
}

export default function ClientContacts({ lawFirmId, clientId, clientType }: Props) {
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canOpenDirectory = hasPermission("contacts.view");
  const canManage = hasPermission("clients.manage");
  const isCompany = clientType === "company";
  const [contacts, setContacts] = useState<ClientContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Firm/client props can change before an older roster request returns. Keep
  // stale contacts from one tenant visible in the next tenant's tab.
  const loadGeneration = useRef(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<ClientContact | null>(null);
  const [contactToDelete, setContactToDelete] = useState<ClientContact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // How many roster links currently carry billing delivery, so the modal (last
  // recipient) and the remove-contact confirmation below can warn before a
  // change would leave the company with none.
  const billingRecipientCount = useMemo(
    () => contacts.filter((c) => c.isEmailRecipient).length,
    [contacts],
  );

  const sortedContacts = useMemo(() => {
    return [...contacts].sort((a, b) => {
      if (a.isPrimary && !b.isPrimary) return -1;
      if (!a.isPrimary && b.isPrimary) return 1;
      return (a.name || "").localeCompare(b.name || "");
    });
  }, [contacts]);

  // Corporate clients carry many stakeholders, so the rendered rows are windowed.
  const contactsPager = usePagedRows(sortedContacts, 10);

  const loadContacts = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const isCurrentLoad = () => generation === loadGeneration.current;

    try {
      setLoading(true);
      setError(null);
      const response = await clientsService.listClientContacts(lawFirmId, clientId);
      if (!isCurrentLoad()) return;
      setContacts(response || []);
    } catch (err) {
      if (!isCurrentLoad()) return;
      setError(getErrorMessage(err, "Failed to load contacts"));
      setContacts([]);
    } finally {
      if (isCurrentLoad()) setLoading(false);
    }
  }, [lawFirmId, clientId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- triggers an async data fetch on mount
    loadContacts();
  }, [loadContacts]);

  const openAdd = () => {
    setEditingContact(null);
    setModalOpen(true);
  };

  const openEdit = (contact: ClientContact) => {
    setEditingContact(contact);
    setModalOpen(true);
  };

  const handleDelete = async () => {
    if (!contactToDelete) return;

    try {
      setDeleting(true);
      setError(null);
      await clientsService.deleteClientContact(lawFirmId, clientId, contactToDelete.id);
      setContactToDelete(null);
      await loadContacts();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to delete contact"));
    } finally {
      setDeleting(false);
    }
  };

  // Removing this contact would leave the company with zero billing
  // recipients, so the delete confirmation below says so explicitly.
  const removingLastEmailRecipient =
    !!contactToDelete?.isEmailRecipient && billingRecipientCount <= 1;

  if (loading) {
    return <ListSkeleton rows={4} label="Loading client contacts" />;
  }

  return (
    <div className="space-y-4">
      <ErrorNotification error={error} onClose={() => setError(null)} />

      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-on-surface">
            {isCompany ? "Related Clients" : "Related Contacts"}
          </h3>
          <p className="text-sm text-on-surface-secondary">
            {isCompany
              ? "People at this company, each their own client with their own billing and portal access."
              : "Guardians, assistants, billing contacts, and other stakeholders for this client."}
          </p>
        </div>
        {canManage && (
          <Button
            size="compact"
            onClick={openAdd}
            icon={<Plus size={14} strokeWidth={2.2} />}
          >
            {isCompany ? "Add Client" : "Add Contact"}
          </Button>
        )}
      </div>

      {sortedContacts.length === 0 ? (
        <ListEmptyState
          compact
          icon={<UserRound size={32} />}
          title={isCompany ? "No linked clients yet" : "No contacts yet"}
          message={
            isCompany
              ? "Link people at this company as clients of their own, so each can bill, sign, and use the client portal individually."
              : "Add contacts for guardians, assistants, billing contacts, and other stakeholders."
          }
        />
      ) : (
        <div className="space-y-2">
          {contactsPager.pagedRows.map((contact) => {
            // The two shapes never mix within one list - a company's rows all
            // carry `personClientId`, a person's own related contacts all
            // carry `contactId`. Narrowing through the roster-only variable
            // (rather than a plain boolean) is what lets TypeScript follow
            // which union member each roster-only field below belongs to.
            const rosterContact = isCompanyRosterContact(contact) ? contact : null;
            const personContact = isPersonRelatedContact(contact) ? contact : null;
            return (
              <div
                key={contact.id}
                className="bg-surface rounded-2xl border border-outline-subtle p-6 space-y-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-on-surface truncate">{contact.name}</p>
                      {contact.isPrimary && (
                        <StatusBadge variant="info"><Star size={11} /> Primary</StatusBadge>
                      )}
                      {isCompany && contact.isEmailRecipient && (
                        contact.email ? (
                          <Tooltip title="Invoices, reminders, and payment receipts will be emailed to this person" enterDelay={300}>
                            <span>
                              <StatusBadge variant="success"><DollarSign size={11} /> Receives emails</StatusBadge>
                            </span>
                          </Tooltip>
                        ) : (
                          <Tooltip title="No email address added: emails cannot be delivered until an email address is added" enterDelay={300}>
                            <span>
                              <StatusBadge variant="warning"><AlertTriangle size={11} /> Receives emails (No Email)</StatusBadge>
                            </span>
                          </Tooltip>
                        )
                      )}
                      {isCompany && !contact.isEmailRecipient && (
                        <Tooltip title="This member is not set to receive billing emails" enterDelay={300}>
                          <span>
                            <StatusBadge variant="neutral"><Mail size={11} /> No email delivery</StatusBadge>
                          </span>
                        </Tooltip>
                      )}
                      {isCompany && contact.canViewBilling && (
                        <Tooltip title="Allows viewing organization invoices in the client portal" enterDelay={300}>
                          <span>
                            <StatusBadge variant="purple"><Eye size={11} /> Can view billing</StatusBadge>
                          </span>
                        </Tooltip>
                      )}
                      {isCompany && !contact.canViewBilling && (
                        <Tooltip title="This member cannot view billing in the client portal" enterDelay={300}>
                          <span>
                            <StatusBadge variant="neutral"><EyeOff size={11} /> No billing access</StatusBadge>
                          </span>
                        </Tooltip>
                      )}
                      {rosterContact?.status === "archived" && (
                        <StatusBadge variant="neutral">Archived</StatusBadge>
                      )}
                    </div>
                    {personContact && (
                      <p className="text-xs text-on-surface-secondary mt-0.5">
                        {[personContact.title, personContact.organization].filter(Boolean).join(" · ") || "Contact"}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {rosterContact ? (
                      <Button
                        type="secondary"
                        size="small"
                        onClick={() => navigate(`/lawfirm/${lawFirmId}/clients/${rosterContact.personClientId}`)}
                        icon={<ExternalLink size={12} />}
                      >
                        Open
                      </Button>
                    ) : (
                      canOpenDirectory && contact.contactId && (
                        <Button
                          type="secondary"
                          size="small"
                          onClick={() => navigate(`/lawfirm/${lawFirmId}/contacts/${contact.contactId}`)}
                          icon={<ExternalLink size={12} />}
                        >
                          Open
                        </Button>
                      )
                    )}
                    {canManage && (
                      <>
                        <Button
                          type="secondary"
                          size="small"
                          onClick={() => openEdit(contact)}
                          icon={<Pencil size={12} />}
                        >
                          Edit
                        </Button>
                        <Button
                          type="danger"
                          size="small"
                          onClick={() => setContactToDelete(contact)}
                          icon={<Trash2 size={12} />}
                        >
                          Remove
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5 text-sm text-on-surface-secondary">
                  {personContact?.organization && (
                    <p className="flex items-center gap-2">
                      <Building2 size={13} className="text-on-surface-muted" />
                      {personContact.organization}
                    </p>
                  )}
                  {contact.email && (
                    <p className="flex items-center gap-2">
                      <Mail size={13} className="text-on-surface-muted" />
                      {contact.email}
                    </p>
                  )}
                  {contact.phone && (
                    <p className="flex items-center gap-2">
                      <Phone size={13} className="text-on-surface-muted" />
                      {contact.phone}
                    </p>
                  )}
                  {contact.relationship && <p>Relationship: {contact.relationship}</p>}
                  {personContact?.notes && <p className="whitespace-pre-wrap">{personContact.notes}</p>}
                </div>

                {rosterContact && (() => {
                  const portalStatus = rosterPortalStatus(rosterContact);
                  const meta = clientPortalStatusMeta(portalStatus);
                  return (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-outline-subtle">
                      <div className="flex items-center gap-2 pt-2.5">
                        <span className="text-xs font-medium text-on-surface-secondary">Portal access:</span>
                        <StatusBadge variant={meta.variant}>{meta.label}</StatusBadge>
                      </div>
                      {canManage && (
                        <div className="pt-2.5">
                          <Button
                            type="secondary"
                            size="small"
                            onClick={() => navigate(`/lawfirm/${lawFirmId}/clients/${rosterContact.personClientId}?highlight=portal`)}
                            icon={<ExternalLink size={12} />}
                          >
                            Manage portal access
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })}
          {contactsPager.total > contactsPager.rowsPerPage && (
            <div className="bg-surface rounded-2xl border border-outline-subtle">
              <AutoPager pager={contactsPager} />
            </div>
          )}
        </div>
      )}

      <ClientContactModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={loadContacts}
        lawFirmId={lawFirmId}
        clientId={clientId}
        editing={editingContact}
        clientType={clientType}
        otherEmailRecipientCount={
          editingContact
            ? contacts.filter((c) => c.id !== editingContact.id && c.isEmailRecipient).length
            : billingRecipientCount
        }
      />

      <ConfirmModal
        isOpen={!!contactToDelete}
        onClose={() => setContactToDelete(null)}
        onConfirm={handleDelete}
        title={contactToDelete?.personClientId ? "Remove from company" : "Remove contact"}
        message={
          contactToDelete?.personClientId
            ? (removingLastEmailRecipient
                ? `Remove ${contactToDelete?.name ?? "this client"} from this company? Their own client record is unaffected. This is the company's only email recipient, so invoices and client notifications will have nowhere to send.`
                : `Remove ${contactToDelete?.name ?? "this client"} from this company? Their own client record is unaffected.`)
            : (removingLastEmailRecipient
                ? `Remove ${contactToDelete?.name ?? "this contact"} from this client? They stay in your firm's contacts. This is the client's only email recipient, so invoices and client notifications will have nowhere to send.`
                : `Remove ${contactToDelete?.name ?? "this contact"} from this client? They stay in your firm's contacts.`)
        }
        confirmText="Remove"
        loading={deleting}
      />
    </div>
  );
}
