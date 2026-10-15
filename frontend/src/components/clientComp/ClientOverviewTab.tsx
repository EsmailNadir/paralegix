"use client";

import { formatCurrency } from "@/components/billingComp/utils";
import ClientOrganizationAutocomplete from "@/components/clientComp/ClientOrganizationAutocomplete";
import ActionIconButton from "@/components/ui/ActionIconButton";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Dropdown from "@/components/ui/Dropdown";
import DuplicateNameWarning from "@/components/ui/DuplicateNameWarning";
import FieldLabel from "@/components/ui/FieldLabel";
import StatTile from "@/components/ui/StatTile";
import { clientStatusMeta } from "@/constants/statusMeta";
import { useNavigation } from "@/contexts/NavigationContext";
import { useClientsAtOrganization,useLinkedCompanyClient } from "@/hooks/clientHooks/useClients";
import { useDuplicateNameCheck } from "@/hooks/useEntityLookup";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import clientsService,{ type ClientSummary,type ClientUpsertPayload,type LookupItem } from "@/services/clients.service";
import type { Client,ClientCompanyRelationship,ClientStatus,PreferredContactMethod } from "@/types";
import type { Conversation } from "@/types/message";
import { useQueryClient } from "@tanstack/react-query";
import {
Briefcase,
Building2,
ClipboardCheck,
DollarSign,
Mail,
Pencil,
Trash2
} from "lucide-react";
import { useEffect,useId,useState } from "react";

import type { ClientDetailTab as Tab } from "./clientDetailTypes";
const PREFERRED_CONTACT_LABELS: Record<string, string> = {
  email: "Email",
  phone: "Phone",
  sms: "SMS",
  portal: "Portal",
};

export default function ClientOverviewTab({
  client,
  summary,
  taskCount,
  conversations,
  lawFirmId,
  clientId,
  canEdit,
  canViewMessaging,
  externalEditing,
  onExternalEditingDone,
  onClientUpdated,
  companyRelationships,
  refreshCompanyRelationships,
  onOpenTab,
}: {
  client: Client;
  /** Server-counted matters and billing totals. A null section (no permission)
   *  shows the zeroes an empty list would. */
  summary: ClientSummary | undefined;
  /** How many tasks the client has, across every matter they are on. */
  taskCount: number;
  conversations: Conversation[];
  lawFirmId: string;
  clientId: string;
  canEdit: boolean;
  externalEditing?: boolean;
  onExternalEditingDone?: () => void;
  /** Whether the viewer may read messages; the unread-messages tile opens a tab they are not shown otherwise. */
  canViewMessaging: boolean;
  onClientUpdated: (data: Partial<Client>) => void;
  /** Owned by ClientDetail and shared with every other tab that badges a
   *  linked company's items, so there is only ever one fetch of it. */
  companyRelationships: ClientCompanyRelationship[];
  refreshCompanyRelationships: () => void;
  /** Switches the page to another tab, so the quick-stat tiles can open the tab they count. */
  onOpenTab: (tab: Tab) => void;
}) {
  const fieldIds = useId();
  const { navigate } = useNavigation();
  const queryClient = useQueryClient();
  // Owned invoices only, summed in cents by the server; outstanding is billed
  // minus paid and is not clamped, exactly as the old in-browser sum was.
  const matterCount = summary?.matters?.count ?? 0;
  const invoiceCount = summary?.billing?.invoiceCount ?? 0;
  const totalBilled = (summary?.billing?.totalBilledCents ?? 0) / 100;
  const totalPaid = (summary?.billing?.totalPaidCents ?? 0) / 100;
  const outstanding = (summary?.billing?.outstandingCents ?? 0) / 100;
  const unreadMessages = conversations.reduce((sum, item) => sum + (item.unreadCountFirm || 0), 0);
  const { colleagues: orgColleagues } = useClientsAtOrganization(lawFirmId, clientId, client.organization);
  const { company: linkedCompany } = useLinkedCompanyClient(lawFirmId, client.organization);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [companyRelationshipDrafts, setCompanyRelationshipDrafts] = useState<Record<string, {
    isPrimary: boolean;
    isEmailRecipient: boolean;
    canViewBilling: boolean;
  }>>({});
  const [relationshipToRemove, setRelationshipToRemove] = useState<ClientCompanyRelationship | null>(null);
  // Set when saving would clear the last "Receives emails" person at one of the
  // linked companies. Holds the save until the firm confirms, matching the
  // warning the company's own roster editors already show.
  const [confirmingLastRecipient, setConfirmingLastRecipient] = useState(false);
  const [removingRelationship, setRemovingRelationship] = useState(false);
  // Set when Save is clicked and the Organization field implies a relationship
  // change (it no longer names a company it used to, and/or it now names a
  // real company client this person isn't linked to yet): holds the confirm
  // dialog open until the user decides whether to apply that change too.
  const [pendingOrgChange, setPendingOrgChange] = useState<{
    unlink: ClientCompanyRelationship | null;
    link: LookupItem | null;
  } | null>(null);
  const [form, setForm] = useState({
    name: client.name || "",
    email: client.email || "",
    phone: client.phone || "",
    organization: client.organization || "",
    address: client.address || "",
    preferredContactMethod: client.preferredContactMethod || "none",
    status: client.status || "active",
  });
  // Whatever real company client the Organization field currently names, kept
  // live as the user types, so Save can offer to link it if it isn't already.
  const { company: formOrgCompanyMatch } = useLinkedCompanyClient(lawFirmId, form.organization);
  const { duplicate: duplicateClient } = useDuplicateNameCheck("clients", lawFirmId, form.name, {
    enabled: editing,
    excludeId: clientId,
  });

  useEffect(() => {
    if (externalEditing && !editing) {
      handleStartEdit();
      onExternalEditingDone?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalEditing]);

  const handleStartEdit = () => {
    setForm({
      name: client.name || "",
      email: client.email || "",
      phone: client.phone || "",
      organization: client.organization || "",
      address: client.address || "",
      preferredContactMethod: client.preferredContactMethod || "none",
      status: client.status || "active",
    });
    setCompanyRelationshipDrafts(Object.fromEntries(companyRelationships.map((relationship) => [
      relationship.id,
      {
        isPrimary: relationship.isPrimary,
        isEmailRecipient: relationship.isEmailRecipient,
        canViewBilling: relationship.canViewBilling,
      },
    ])));
    setEditError(null);
    setEditing(true);
  };

  const updateCompanyRelationshipDraft = (
    relationshipId: string,
    field: "isPrimary" | "isEmailRecipient" | "canViewBilling",
    value: boolean,
  ) => {
    const relationship = companyRelationships.find((item) => item.id === relationshipId);
    if (!relationship) return;
    setCompanyRelationshipDrafts((drafts) => ({
      ...drafts,
      [relationshipId]: {
        ...drafts[relationshipId],
        isPrimary: drafts[relationshipId]?.isPrimary ?? relationship.isPrimary,
        isEmailRecipient: drafts[relationshipId]?.isEmailRecipient ?? relationship.isEmailRecipient,
        canViewBilling: drafts[relationshipId]?.canViewBilling ?? relationship.canViewBilling,
        [field]: value,
      },
    }));
  };

  // Unlinking is a client_company_links row keyed by the COMPANY's id, not
  // this person's, so it goes through the same dispatcher ClientContacts.tsx
  // uses on the company's own page, just called with companyClientId here
  // instead of the page's own clientId.
  const handleRemoveCompanyRelationship = async () => {
    if (!relationshipToRemove) return;
    setRemovingRelationship(true);
    try {
      await clientsService.deleteClientContact(lawFirmId, relationshipToRemove.companyClientId, relationshipToRemove.id);
      // The free-text Organization field is separate from the structured link,
      // but when it currently just names the company being unlinked, leaving it
      // behind reads as if the relationship is still there. Clear it too, and
      // persist that immediately (not only in the draft) so it's correct even
      // if the user closes this form without hitting Save.
      const orgMatchesRemovedCompany =
        form.organization.trim().toLowerCase() === relationshipToRemove.companyName.trim().toLowerCase();
      if (orgMatchesRemovedCompany) {
        await clientsService.updateClient(lawFirmId, clientId, { organization: null });
        setForm((f) => ({ ...f, organization: "" }));
        onClientUpdated({ organization: null });
      }
      setCompanyRelationshipDrafts((drafts) => {
        const rest = { ...drafts };
        delete rest[relationshipToRemove.id];
        return rest;
      });
      setRelationshipToRemove(null);
      await refreshCompanyRelationships();
      // Other people linked to this same company each cache their own
      // relationship list under their own client id (see the isPrimary note
      // in performSave below); a removal doesn't reassign anyone else's
      // primary status, but it can free up the "one primary" slot other
      // pages may act on next, so keep every sibling's cache in step too.
      queryClient.invalidateQueries({ queryKey: ["clients", lawFirmId, "companyRelationships"] });
    } catch (err) {
      setEditError(getErrorMessage(err, "Failed to remove company relationship"));
    } finally {
      setRemovingRelationship(false);
    }
  };

  // What the Organization field implies about the structured relationship(s),
  // relative to their current state:
  // - unlink: the field USED TO name a company this person is linked to, and
  //    has since changed away from it (a real edit, not just "it was already
  //    blank" or "nothing changed"). Save should offer to remove that link.
  // - link: the field CURRENTLY names a real company client this person
  //    isn't linked to yet. Save should offer to create that link. Checked
  //    on every save (not diff-gated) so simply re-entering an already-set
  //    but never-actually-linked company name resolves it, since retyping
  //    the same final value produces no diff to detect.
  // Creating a link is additive/low-risk, so it's fine to keep offering it
  // every save until resolved; removing one is real data loss, so that side
  // stays diff-gated to avoid surprising an unrelated edit.
  const findOrgChangeEffects = (): { unlink: ClientCompanyRelationship | null; link: LookupItem | null } | null => {
    const originalOrg = (client.organization || "").trim().toLowerCase();
    const newOrg = form.organization.trim().toLowerCase();
    const unlink = (originalOrg && newOrg !== originalOrg)
      ? companyRelationships.find(
          (relationship) => relationship.companyName.trim().toLowerCase() === originalOrg,
        ) || null
      : null;
    const link = (formOrgCompanyMatch && !companyRelationships.some(
      (relationship) => relationship.companyClientId === formOrgCompanyMatch.id,
    )) ? formOrgCompanyMatch : null;
    if (!unlink && !link) return null;
    return { unlink, link };
  };

  const performSave = async (effects: { unlink: ClientCompanyRelationship | null; link: LookupItem | null } | null) => {
    setSaving(true);
    setEditError(null);
    try {
      const payload: ClientUpsertPayload = {
        name: form.name.trim(),
        // null (not undefined) so cleared fields actually persist as cleared.
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        organization: client.clientType !== "company" ? (form.organization.trim() || null) : null,
        address: form.address.trim() || null,
        status: form.status as ClientUpsertPayload["status"],
        // "None" clears a stored preference. The route reads an absent key as
        // "leave it alone", so it has to go out as null.
        preferredContactMethod: form.preferredContactMethod && form.preferredContactMethod !== "none"
          ? form.preferredContactMethod as ClientUpsertPayload["preferredContactMethod"]
          : null,
      };
      await clientsService.updateClient(lawFirmId, clientId, payload);
      await Promise.all(companyRelationships.flatMap((relationship) => {
        // About to be deleted below; no point writing flag changes to a row
        // that won't exist a moment later.
        if (effects?.unlink && relationship.id === effects.unlink.id) return [];
        const draft = companyRelationshipDrafts[relationship.id];
        if (!draft
          || (draft.isPrimary === relationship.isPrimary
            && draft.isEmailRecipient === relationship.isEmailRecipient
            && draft.canViewBilling === relationship.canViewBilling)) {
          return [];
        }
        return [clientsService.updateClientContact(lawFirmId, relationship.companyClientId, relationship.id, draft)];
      }));
      // Same dispatchers the company's own Contacts tab uses to add/remove a
      // person from its roster (keyed by the company's id, not this person's).
      // They already invalidate the person's cached portal-access context (and,
      // for removal, drop them from the company's conversation), so portal
      // access to that company's data updates the same way regardless of which
      // side of the relationship triggered the change.
      if (effects?.unlink) {
        await clientsService.deleteClientContact(lawFirmId, effects.unlink.companyClientId, effects.unlink.id);
        setCompanyRelationshipDrafts((drafts) => {
          const rest = { ...drafts };
          delete rest[effects.unlink!.id];
          return rest;
        });
      }
      if (effects?.link) {
        await clientsService.createClientContact(lawFirmId, effects.link.id, { personClientId: clientId });
      }
      onClientUpdated(payload);
      void refreshCompanyRelationships();
      // Setting isPrimary true on one relationship makes the backend clear it
      // on every OTHER person linked to that company, in the same DB
      // transaction (see updateClientContact/createClientContact). Those
      // people's own pages cache their relationship list under their own
      // client id (useClientCompanyRelationships), so nothing here would
      // otherwise tell an already-open or -cached copy of their page that
      // its "Primary contact" checkbox is now stale.
      queryClient.invalidateQueries({ queryKey: ["clients", lawFirmId, "companyRelationships"] });
      setPendingOrgChange(null);
      setEditing(false);
    } catch (err) {
      // The steps above aren't one transaction, so a failure partway through
      // (e.g. the unlink succeeded but the link that was meant to replace it
      // hit a conflict) can leave real, partial changes in the database.
      // Refresh so the next attempt computes its unlink/link decision off
      // what's actually there, and close the modal so the error below it
      // (otherwise hidden behind the overlay) is visible.
      void refreshCompanyRelationships();
      queryClient.invalidateQueries({ queryKey: ["clients", lawFirmId, "companyRelationships"] });
      setPendingOrgChange(null);
      setEditError(getErrorMessage(err, "Failed to update client"));
    } finally {
      setSaving(false);
    }
  };

  // Every company whose LAST "Receives emails" person this save would clear.
  // A company's invoices go only to the people flagged here, so leaving one
  // with none means it cannot be invoiced at all until someone is put back on
  // the list. `companyEmailRecipientCount` counts the whole roster and comes
  // from the server, because this form only loads the viewed person's own
  // links and so cannot see who else at that company receives its email.
  const companiesLosingLastRecipient = companyRelationships.filter((relationship) => {
    const draft = companyRelationshipDrafts[relationship.id];
    if (!draft || !relationship.isEmailRecipient || draft.isEmailRecipient) return false;
    return relationship.companyEmailRecipientCount <= 1;
  });

  const handleSaveClick = () => {
    if (!form.name.trim()) {
      setEditError("Name is required");
      return;
    }
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setEditError("Please enter a valid email address");
      return;
    }
    if (companiesLosingLastRecipient.length) {
      setConfirmingLastRecipient(true);
      return;
    }
    const effects = findOrgChangeEffects();
    if (effects) {
      setPendingOrgChange(effects);
      return;
    }
    void performSave(null);
  };

  // Continue the save the last-recipient warning interrupted, handing off to
  // the organization-link confirm when the Organization field ALSO changed, so
  // one save never skips the other warning.
  const handleConfirmLastRecipient = () => {
    setConfirmingLastRecipient(false);
    const effects = findOrgChangeEffects();
    if (effects) {
      setPendingOrgChange(effects);
      return;
    }
    void performSave(null);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatTile label="Matters" value={matterCount} icon={Briefcase} onClick={() => onOpenTab("matters")} />
        <StatTile label="Tasks" value={taskCount} icon={ClipboardCheck} onClick={() => onOpenTab("tasks")} />
        {canViewMessaging && (
          <StatTile label="Unread Messages" value={unreadMessages} icon={Mail} onClick={() => onOpenTab("messages")} />
        )}
        <StatTile label="Open Balance" value={formatCurrency(outstanding)} icon={DollarSign} onClick={() => onOpenTab("billing")} actionLabel="View Billing" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="bg-surface rounded-2xl border border-outline-subtle p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-on-surface">
              Client Profile
            </h3>
            {canEdit && !editing && (
              <button
                onClick={handleStartEdit}
                className="inline-flex items-center gap-1 text-xs text-accent-emphasis hover:underline font-medium cursor-pointer"
              >
                <Pencil size={12} />
                Edit
              </button>
            )}
          </div>

          {editing ? (
            <div className="space-y-3">
              {editError && (
                <div className="p-2.5 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-700 rounded-lg text-xs text-rose-700 dark:text-rose-300">
                  {editError}
                </div>
              )}
              {/* Immutable after creation (DB trigger). Never offer a control to
                  change it, just say what it is. */}
              <p className="text-xs text-on-surface-muted">
                Type: {client.clientType === "company" ? "Organization" : "Person"}
              </p>
              <div>
                <FieldLabel htmlFor={`${fieldIds}-form`} size="xs" tone="secondary">
                  {client.clientType === "company" ? "Organization Name *" : "Name *"}
                </FieldLabel>
                <input
                  id={`${fieldIds}-form`}
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-input-border bg-input-bg text-on-surface rounded-lg focus-visible:ring-2 focus-visible:ring-focus-ring outline-none"
                />
                <DuplicateNameWarning duplicateName={duplicateClient?.label} entityLabel="client" />
              </div>
              <div>
                <FieldLabel htmlFor={`${fieldIds}-email`} size="xs" tone="secondary">Email</FieldLabel>
                <input
                  id={`${fieldIds}-email`}
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-input-border bg-input-bg text-on-surface rounded-lg focus-visible:ring-2 focus-visible:ring-focus-ring outline-none"
                />
              </div>
              <div>
                <FieldLabel htmlFor={`${fieldIds}-phone`} size="xs" tone="secondary">Phone</FieldLabel>
                <input
                  id={`${fieldIds}-phone`}
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-input-border bg-input-bg text-on-surface rounded-lg focus-visible:ring-2 focus-visible:ring-focus-ring outline-none"
                />
              </div>
              {client.clientType !== "company" && (
                <div>
                  <FieldLabel size="xs" tone="secondary">Organization</FieldLabel>
                  <ClientOrganizationAutocomplete
                    lawFirmId={lawFirmId}
                    value={form.organization}
                    onChange={(v) => setForm((f) => ({ ...f, organization: v }))}
                  />
                </div>
              )}
              {client.clientType !== "company" && companyRelationships.length > 0 && (
                <div className="rounded-lg border border-outline-subtle bg-surface-alt p-3 space-y-3">
                  <div>
                    <p className="text-xs font-medium text-on-surface">Organization relationship</p>
                    <p className="text-xs text-on-surface-muted mt-0.5">
                      These settings apply to this person at each organization, not to their personal client record.
                    </p>
                  </div>
                  {companyRelationships.map((relationship) => {
                    const draft = companyRelationshipDrafts[relationship.id] ?? relationship;
                    return (
                      <div key={relationship.id} className="space-y-2 border-t border-outline-subtle pt-3 first:border-t-0 first:pt-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-on-surface">{relationship.companyName}</p>
                          <ActionIconButton
                            label={`Remove relationship with ${relationship.companyName}`}
                            onClick={() => setRelationshipToRemove(relationship)}
                            tone="danger"
                          >
                            <Trash2 size={13} />
                          </ActionIconButton>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                          <label className="inline-flex items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs text-on-surface">
                            <Checkbox
                              checked={draft.isPrimary}
                              onChange={(value) => updateCompanyRelationshipDraft(relationship.id, "isPrimary", value)}
                            />
                            Primary contact
                          </label>
                          <label className="inline-flex items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs text-on-surface">
                            <Checkbox
                              checked={draft.isEmailRecipient}
                              onChange={(value) => updateCompanyRelationshipDraft(relationship.id, "isEmailRecipient", value)}
                            />
                            Receives emails
                          </label>
                          <label className="inline-flex items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs text-on-surface">
                            <Checkbox
                              checked={draft.canViewBilling}
                              onChange={(value) => updateCompanyRelationshipDraft(relationship.id, "canViewBilling", value)}
                            />
                            Can view billing
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div>
                <FieldLabel htmlFor={`${fieldIds}-address`} size="xs" tone="secondary">Address</FieldLabel>
                <input
                  id={`${fieldIds}-address`}
                  type="text"
                  value={form.address}
                  onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-input-border bg-input-bg text-on-surface rounded-lg focus-visible:ring-2 focus-visible:ring-focus-ring outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel id={`${fieldIds}-preferred-contact-label`} size="xs" tone="secondary">Preferred Contact</FieldLabel>
                  <Dropdown
                    ariaLabelledBy={`${fieldIds}-preferred-contact-label`}
                    value={form.preferredContactMethod}
                    onChange={(value) => setForm((f) => ({ ...f, preferredContactMethod: value as PreferredContactMethod }))}
                    options={[
                      { value: "none", label: "None" },
                      { value: "email", label: "Email" },
                      { value: "phone", label: "Phone" },
                      { value: "sms", label: "SMS" },
                    ]}
                    buttonClassName="border-input-border bg-input-bg"
                  />
                </div>
                <div>
                  <FieldLabel id={`${fieldIds}-status-label`} size="xs" tone="secondary">Status</FieldLabel>
                  <Dropdown
                    ariaLabelledBy={`${fieldIds}-status-label`}
                    value={form.status}
                    onChange={(value) => setForm((f) => ({ ...f, status: value as ClientStatus }))}
                    options={[
                      { value: "active", label: "Active" },
                      { value: "inactive", label: "Inactive" },
                      { value: "archived", label: "Archived" },
                    ]}
                    buttonClassName="border-input-border bg-input-bg"
                  />
                </div>
              </div>
              {!form.email.trim() && !client.joinedAt && !client.invitedAt && (
                <p className="text-xs text-on-surface-muted">
                  Add an email above to invite this client to the portal.
                </p>
              )}
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button type="secondary" size="small" onClick={() => { setEditing(false); setPendingOrgChange(null); }} disabled={saving}>
                  Cancel
                </Button>
                <Button type="primary" size="small" onClick={handleSaveClick} disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-on-surface"><span className="font-medium">Type:</span> {client.clientType === "company" ? "Organization" : "Person"}</p>
              <p className="text-sm text-on-surface"><span className="font-medium">{client.clientType === "company" ? "Organization Name" : "Name"}:</span> {client.name || "Unnamed"}</p>
              <p className="text-sm text-on-surface"><span className="font-medium">Email:</span> {client.email || "Not set"}</p>
              <p className="text-sm text-on-surface"><span className="font-medium">Phone:</span> {client.phone || "Not set"}</p>
              {client.clientType !== "company" && (
                <>
                  <p className="text-sm text-on-surface">
                    <span className="font-medium">Organization:</span>{" "}
                    {linkedCompany ? (
                      <button
                        type="button"
                        onClick={() => navigate(`/lawfirm/${lawFirmId}/clients/${linkedCompany.id}`)}
                        className="text-accent-emphasis hover:underline cursor-pointer"
                      >
                        {client.organization}
                      </button>
                    ) : (
                      client.organization || "Not set"
                    )}
                  </p>
                  {orgColleagues.length > 0 && (
                    <p className="text-xs text-on-surface-muted flex items-start gap-1.5 pl-0.5">
                      <Building2 size={13} className="mt-0.5 shrink-0" />
                      <span>
                        Also at {client.organization}:{" "}
                        {orgColleagues.map((colleague, index) => (
                          <span key={colleague.id}>
                            <button
                              type="button"
                              onClick={() => navigate(`/lawfirm/${lawFirmId}/clients/${colleague.id}`)}
                              className="text-accent-emphasis hover:underline cursor-pointer"
                            >
                              {colleague.label}
                            </button>
                            {index < orgColleagues.length - 1 ? ", " : ""}
                          </span>
                        ))}
                      </span>
                    </p>
                  )}
                </>
              )}
              <p className="text-sm text-on-surface"><span className="font-medium">Address:</span> {client.address || "Not set"}</p>
              <p className="text-sm text-on-surface">
                <span className="font-medium">Preferred Contact:</span>{" "}
                {PREFERRED_CONTACT_LABELS[client.preferredContactMethod || ""] || "Not set"}
              </p>
              <p className="text-sm text-on-surface">
                <span className="font-medium">Status:</span> {clientStatusMeta(client.status).label}
              </p>
            </div>
          )}
        </div>

        <div className="bg-surface rounded-2xl border border-outline-subtle p-5 space-y-2">
          <h3 className="text-sm font-semibold text-on-surface">
            Billing Snapshot
          </h3>
          <p className="text-sm text-on-surface"><span className="font-medium">Invoices:</span> {invoiceCount}</p>
          <p className="text-sm text-on-surface"><span className="font-medium">Total Billed:</span> {formatCurrency(totalBilled)}</p>
          <p className="text-sm text-on-surface"><span className="font-medium">Total Paid:</span> {formatCurrency(totalPaid)}</p>
          <p className="text-sm text-on-surface"><span className="font-medium">Outstanding:</span> {formatCurrency(outstanding)}</p>
          <p className="text-xs text-on-surface-muted pt-1">
            Includes both matter-context and direct client-context invoices.
          </p>
        </div>
      </div>

      <ConfirmModal
        isOpen={confirmingLastRecipient}
        onClose={() => setConfirmingLastRecipient(false)}
        onConfirm={handleConfirmLastRecipient}
        title="Remove last email recipient?"
        message={`${client.name || "This client"} is the only person receiving email for ${
          companiesLosingLastRecipient.map((relationship) => relationship.companyName).join(", ")
          || "that company"
        }. After this change, its invoices and client notifications will have nowhere to send until you add a new recipient.`}
        confirmText={saving ? "Saving..." : "Save Anyway"}
        confirmType="danger"
      />

      <ConfirmModal
        isOpen={!!relationshipToRemove}
        onClose={() => setRelationshipToRemove(null)}
        onConfirm={handleRemoveCompanyRelationship}
        title="Remove company relationship"
        message={`Remove ${client.name || "this client"}'s relationship with ${relationshipToRemove?.companyName || "this company"}? Their own client record is unaffected, but they will stop seeing that company's tasks, matters, events, notes, time entries, and billing on this page.${
          // Unlinking takes the person off the company's email list along with
          // everything else, so it can leave the company unbillable exactly the
          // way clearing the flag does. Say so here rather than only there.
          relationshipToRemove?.isEmailRecipient && relationshipToRemove.companyEmailRecipientCount <= 1
            ? ` They are also the only person receiving email for ${relationshipToRemove.companyName}, so its invoices will have nowhere to send until you add a new recipient.`
            : ""
        }`}
        confirmText={removingRelationship ? "Removing..." : "Remove"}
      />

      <ConfirmModal
        isOpen={!!pendingOrgChange}
        onClose={() => setPendingOrgChange(null)}
        onConfirm={() => performSave(pendingOrgChange)}
        title={
          pendingOrgChange?.unlink && pendingOrgChange?.link
            ? "Update company relationship?"
            : pendingOrgChange?.link
            ? "Link this company?"
            : "Unlink company relationship?"
        }
        message={
          pendingOrgChange?.unlink && pendingOrgChange?.link
            ? `Saving will move ${client.name || "this client"}'s company relationship from ${pendingOrgChange.unlink.companyName} to ${pendingOrgChange.link.label}: they'll stop seeing ${pendingOrgChange.unlink.companyName}'s items and lose portal access to its data, and start seeing ${pendingOrgChange.link.label}'s tasks, matters, events, notes, time entries, billing, and documents here instead. Continue saving?`
            : pendingOrgChange?.link
            ? `The Organization field names ${pendingOrgChange.link.label}, an existing company client ${client.name || "this client"} isn't linked to yet. Saving will link them: they'll then see that company's tasks, matters, events, notes, time entries, and billing here. Continue saving?`
            : `The Organization field no longer names ${pendingOrgChange?.unlink?.companyName || "the linked company"}. Saving will remove ${client.name || "this client"}'s relationship with ${pendingOrgChange?.unlink?.companyName || "that company"}: they'll stop seeing its tasks, matters, events, notes, time entries, billing, and documents here, and lose portal access to its data. Continue saving?`
        }
        confirmText={
          saving
            ? "Saving..."
            : pendingOrgChange?.unlink && pendingOrgChange?.link
            ? "Update & Save"
            : pendingOrgChange?.link
            ? "Link & Save"
            : "Unlink & Save"
        }
      />
    </div>
  );
}
