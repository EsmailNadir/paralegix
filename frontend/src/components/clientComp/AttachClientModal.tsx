"use client";

import { useId, useRef, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ArrowLeft, Building2, Pencil } from "lucide-react";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Dropdown, { DropdownOption } from "@/components/ui/Dropdown";
import ErrorNotification from "@/components/ErrorNotification";

import Modal from "@/components/ui/Modal";
import { useResetAfterClose } from "@/hooks/useMountTransition";
import { useEntityLookup, useDuplicateNameCheck } from "@/hooks/useEntityLookup";
import { SEARCH_DEBOUNCE_MS, lookupOverflowNote } from "@/lib/constants/search";
import clientsService from "@/services/clients.service";
import type { PreferredContactMethod } from "@/types";
import FieldLabel from "@/components/ui/FieldLabel";
import ClientFields from "@/components/clientComp/ClientFields";
import TextInput from "@/components/ui/TextInput";
import { getErrorMessage } from "@/lib/utils/apiErrors";

/**
 * What the modal is attaching a client to. Matters and tasks both hold a set of
 * clients and both offer the same search / create / edit flow over the firm's
 * client list, so the flow lives here once and each parent supplies only the
 * parts that are genuinely its own.
 */
export type AttachClientTarget = {
  /** Noun for the parent record, used in the copy ("Add Client to Matter"). */
  label: string;
  /** Clients already attached, hidden from the search results. */
  attachedClientIds: string[];
  /** Attach one client to the parent record. */
  attach: (client: { clientId: string; name: string }) => Promise<void>;
  /**
   * Detach one client. Supplied only by parents that support it; when it is
   * absent the roster cleanup below is skipped, because there is no way to
   * remove the superseded rows.
   */
  detach?: (clientId: string) => Promise<void>;
  /** React Query keys to invalidate once the attachment changes. */
  invalidateKeys: readonly (readonly unknown[])[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
  target: AttachClientTarget;
  onAfter?: () => Promise<void> | void;
  /** Open directly in creation when launched from an existing client picker. */
  initialMode?: "search" | "create";
};

const CLIENT_TYPE_OPTIONS: DropdownOption[] = [
  { label: "Person", value: "person" },
  { label: "Organization", value: "company" },
];

/**
 * The message for a client that was saved but could not be linked to the
 * organization typed for them, in the same words the client list uses.
 */
function companyLinkFailure(personName: string, organizationName: string, err: unknown, done: "added" | "saved") {
  const reason = getErrorMessage(err, `Failed to link ${personName} to ${organizationName}`);
  return `${personName} was ${done}, but linking them to ${organizationName} failed: ${reason}`;
}

export default function AttachClientModal({
  open,
  onClose,
  lawFirmId,
  target,
  onAfter,
  initialMode = "search",
}: Props) {
  const fieldIds = useId();
  const { label: targetLabel, attachedClientIds, attach, detach } = target;
  const [mode, setMode] = useState<"search" | "create" | "edit">(initialMode);
  const [editingClientId, setEditingClientId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state (used for create and edit)
  const [clientType, setClientType] = useState<"person" | "company">("person");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [organization, setOrganization] = useState("");
  const [address, setAddress] = useState("");
  const [preferredContactMethod, setPreferredContactMethod] = useState("none");
  const [sendInvite, setSendInvite] = useState(false);
  const [linkedCompanyId, setLinkedCompanyId] = useState<string | null>(null);
  // Whether the edit view holds the client's full record. The list row carries
  // only name, email and type, and the save writes every field (a blank goes out
  // as null), so saving before the detail read succeeds would wipe the stored
  // phone, address and contact preference.
  const [editDetailLoaded, setEditDetailLoaded] = useState(false);

  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["clients", lawFirmId] });
    queryClient.invalidateQueries({ queryKey: ["companyRosterPersonIds", lawFirmId] });
    for (const key of target.invalidateKeys) queryClient.invalidateQueries({ queryKey: key });
  };
  const { duplicate: duplicateClient } = useDuplicateNameCheck("clients", lawFirmId, name, {
    enabled: open && mode === "create",
  });

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(searchTerm), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchTerm]);

  // Counts the client-detail reads started by "Edit Client". A read answers
  // into the form only while it is still the latest one, so a slow answer for
  // a client the user has since left cannot overwrite another client's fields.
  const editRequestRef = useRef(0);

  // The create and edit views share these fields, so each view starts from
  // them blank rather than from whatever the previous one left behind.
  const resetFormFields = () => {
    editRequestRef.current += 1;
    setClientType("person");
    setName("");
    setEmail("");
    setPhone("");
    setOrganization("");
    setAddress("");
    setPreferredContactMethod("none");
    setSendInvite(false);
    setLinkedCompanyId(null);
    setEditDetailLoaded(false);
  };

  // Reset form state after the modal finishes animating closed
  useResetAfterClose(open, () => {
    setMode(initialMode);
    setEditingClientId(null);
    setSearchTerm("");
    setDebouncedSearch("");
    setError(null);
    resetFormFields();
  }, 100);

  const { data: companyRosterPersonIds = [], isLoading: rosterLoading } = useQuery({
    queryKey: ["companyRosterPersonIds", lawFirmId, attachedClientIds],
    queryFn: async () => {
      if (!lawFirmId || attachedClientIds.length === 0) return [];
      const rosterPersonIds: string[] = [];
      await Promise.all(
        attachedClientIds.map(async (clientId) => {
          try {
            const contacts = await clientsService.listClientContacts(lawFirmId, clientId);
            for (const contact of contacts) {
              if (contact.personClientId) {
                rosterPersonIds.push(contact.personClientId);
              }
            }
          } catch {
            // Not a company or has no contacts
          }
        })
      );
      return rosterPersonIds;
    },
    enabled: open && !!lawFirmId && attachedClientIds.length > 0,
    staleTime: 60_000,
  });

  const { items, hasMore, loading } = useEntityLookup("clients", lawFirmId, {
    search: debouncedSearch,
    enabled: open && mode === "search",
  });

  const excludedIds = new Set([...attachedClientIds, ...companyRosterPersonIds]);

  const filteredClients = items
    .filter((item) => !excludedIds.has(item.id))
    .map((item) => ({
      id: item.id,
      name: item.label,
      email: typeof item.sublabel === "string" ? item.sublabel : "",
      clientType: item.clientType || "person",
    }));
  const searching = loading || rosterLoading || searchTerm.trim() !== debouncedSearch.trim();
  const visibleClients = (searchTerm.trim() && searching) || rosterLoading ? [] : filteredClients;
  const overflowNote = lookupOverflowNote(hasMore, searchTerm);

  const handleAddExistingClient = async (clientId: string, clientName: string) => {
    if (submitting) return;

    try {
      setSubmitting(true);
      setError(null);

      // Check whether this client's organization matches an attached organization client
      try {
        const clientDetail = await clientsService.getClient(lawFirmId, clientId);
        if (clientDetail.clientType === "company" && detach) {
          // Attaching an organization supersedes any standalone person rows for
          // its own people, so drop those from the parent record.
          try {
            const contacts = await clientsService.listClientContacts(lawFirmId, clientId);
            const rosterPersonIds = new Set(contacts.map((c) => c.personClientId).filter(Boolean) as string[]);
            const companyName = clientDetail.name?.trim().toLowerCase();

            for (const existingId of attachedClientIds) {
              try {
                const existingDetail = await clientsService.getClient(lawFirmId, existingId);
                const matchesRoster = rosterPersonIds.has(existingId);
                const matchesName = Boolean(companyName && existingDetail.organization?.trim().toLowerCase() === companyName);
                if (matchesRoster || matchesName) {
                  await detach(existingId);
                }
              } catch {
                // Ignore failure for individual client cleanup
              }
            }
          } catch (rosterErr) {
            console.warn("Roster cleanup check failed:", rosterErr);
          }
        } else if (clientDetail.organization?.trim()) {
          const match = await clientsService.lookupClients(lawFirmId, {
            exactName: clientDetail.organization.trim(),
            clientType: "company",
            limit: 1,
          });
          const matchingCompany = match?.items?.[0];
          if (matchingCompany) {
            // Link client to company roster if not already linked
            await clientsService.createClientContact(lawFirmId, matchingCompany.id, {
              personClientId: clientId,
              isPrimary: false,
              // Neither flag is granted here. This link is inferred from the
              // free-text "Organization" field matching a company client's name,
              // which is a guess about where someone works, not a decision about
              // what they may see or be sent. `canViewBilling` opens the
              // organization's invoices, payment history and trust ledger to
              // them in the portal, and `isEmailRecipient` puts them on the
              // distribution its invoices are mailed to. The firm grants both
              // deliberately, on the related-client record, the way every other
              // path already requires. Matching the database defaults.
              isEmailRecipient: false,
              canViewBilling: false,
            });

            // If the company is ALREADY attached, do NOT add a standalone client row.
            if (attachedClientIds.includes(matchingCompany.id)) {
              invalidate();
              await onAfter?.();
              onClose();
              return;
            }
          }
        }
      } catch (err) {
        console.warn("Roster link check failed:", err);
      }

      await attach({ clientId, name: clientName });

      invalidate();
      await onAfter?.();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message || "Failed to add client" : "Failed to add client";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateNewClient = async () => {
    if (!name.trim()) {
      setError("Please enter a client name");
      return;
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Please enter a valid email address");
      return;
    }
    if (submitting) return;

    try {
      setSubmitting(true);
      setError(null);

      // "None" goes out as null so the client is stored with no preference;
      // leaving the field out would take the server's 'email' default.
      const validContactMethods = ["email", "phone", "sms", "portal"];
      const contactMethod = validContactMethods.includes(preferredContactMethod)
        ? (preferredContactMethod as PreferredContactMethod)
        : null;

      // 1. Create client in law firm
      const newClientRes = await clientsService.createClient(lawFirmId, {
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        organization: clientType !== "company" ? (organization.trim() || undefined) : undefined,
        address: address.trim() || undefined,
        preferredContactMethod: contactMethod,
        clientType,
        // Same rule as the other create-client forms: the box only exists for a
        // person with an email, so a stale tick left behind by switching the
        // type or clearing the email must not send an invite.
        portalInvitePending: sendInvite && clientType !== "company" && email.trim() !== "",
      });
      const newClientId = newClientRes.clientId;
      let linkFailure: string | null = null;

      // 2. If Person & Organization provided, try to find matching company client and link them into roster
      let targetCompanyId = linkedCompanyId;
      if (clientType !== "company" && organization.trim()) {
        if (!targetCompanyId) {
          try {
            const match = await clientsService.lookupClients(lawFirmId, {
              exactName: organization.trim(),
              clientType: "company",
              limit: 1,
            });
            if (match?.items && match.items.length > 0) {
              targetCompanyId = match.items[0].id;
            }
          } catch (lookupErr) {
            console.warn("Company lookup error:", lookupErr);
          }
        }

        if (targetCompanyId) {
          try {
            await clientsService.createClientContact(lawFirmId, targetCompanyId, {
              personClientId: newClientId,
              isPrimary: false,
              // See above: an inferred company link grants neither flag.
              isEmailRecipient: false,
              canViewBilling: false,
            });
          } catch (linkErr) {
            linkFailure = companyLinkFailure(name.trim(), organization.trim(), linkErr, "added");
          }
        }
      }

      // 3. Attach the client (unless their company is already attached)
      const isCompanyAlreadyAttached = Boolean(targetCompanyId && attachedClientIds.includes(targetCompanyId));

      if (!isCompanyAlreadyAttached) {
        await attach({ clientId: newClientId, name: name.trim() });
      }

      invalidate();
      await onAfter?.();
      if (newClientRes.portalStatus === "invite_failed") {
        // The client exists and is attached; only the invite email failed. Stay
        // open on the search view so the firm reads that it must resend, and so
        // pressing Create again cannot make a duplicate.
        setMode("search");
        setError("The client was added, but the portal invite email could not be sent. Resend the invite from the client's page.");
        return;
      }
      if (linkFailure) {
        // Same as the invite case: the client exists and is attached, so stay
        // open on the search view and say what was not done.
        setMode("search");
        setError(linkFailure);
        return;
      }
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message || "Failed to create client" : "Failed to create client";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveEditedClient = async () => {
    if (!editingClientId || !name.trim()) {
      setError("Please enter a client name");
      return;
    }
    if (!editDetailLoaded) return;
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Please enter a valid email address");
      return;
    }
    if (submitting) return;

    try {
      setSubmitting(true);
      setError(null);

      // "None" goes out as null, which clears a stored preference; leaving the
      // field out would keep it.
      const validContactMethods = ["email", "phone", "sms", "portal"];
      const contactMethod = validContactMethods.includes(preferredContactMethod)
        ? (preferredContactMethod as PreferredContactMethod)
        : null;

      // 1. Update client in law firm
      await clientsService.updateClient(lawFirmId, editingClientId, {
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        organization: clientType !== "company" ? (organization.trim() || null) : null,
        address: address.trim() || null,
        preferredContactMethod: contactMethod,
      });
      let linkFailure: string | null = null;

      // 2. If Person & Organization provided, try to find matching company client and link into roster
      let targetCompanyId = linkedCompanyId;
      if (clientType !== "company" && organization.trim()) {
        if (!targetCompanyId) {
          try {
            const match = await clientsService.lookupClients(lawFirmId, {
              exactName: organization.trim(),
              clientType: "company",
              limit: 1,
            });
            if (match?.items && match.items.length > 0) {
              targetCompanyId = match.items[0].id;
            }
          } catch (lookupErr) {
            console.warn("Company lookup error:", lookupErr);
          }
        }

        if (targetCompanyId) {
          try {
            await clientsService.createClientContact(lawFirmId, targetCompanyId, {
              personClientId: editingClientId,
              isPrimary: false,
              // See above: an inferred company link grants neither flag.
              isEmailRecipient: false,
              canViewBilling: false,
            });
          } catch (linkErr) {
            // A 409 means the person is already on that organization's roster,
            // which is the outcome this step wanted.
            if ((linkErr as { status?: number })?.status !== 409) {
              linkFailure = companyLinkFailure(name.trim(), organization.trim(), linkErr, "saved");
            }
          }
        }
      }

      // 3. Attach the client (unless their company is already attached)
      const isCompanyAlreadyAttached = Boolean(targetCompanyId && attachedClientIds.includes(targetCompanyId));

      if (!isCompanyAlreadyAttached && !attachedClientIds.includes(editingClientId)) {
        await attach({ clientId: editingClientId, name: name.trim() });
      }

      invalidate();
      await onAfter?.();
      if (linkFailure) {
        setError(linkFailure);
        return;
      }
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message || "Failed to update client" : "Failed to update client";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const switchToCreateMode = (prefillName?: string) => {
    resetFormFields();
    setMode("create");
    setEditingClientId(null);
    if (prefillName) setName(prefillName);
    setError(null);
  };

  const backToSearch = () => {
    // Retires any detail read still in flight for the client being edited.
    editRequestRef.current += 1;
    setMode("search");
  };

  const switchToEditMode = async (c: { id: string; name: string; email?: string; clientType?: "person" | "company"; organization?: string }) => {
    resetFormFields();
    const requestId = editRequestRef.current;
    setMode("edit");
    setEditingClientId(c.id);
    setName(c.name);
    setEmail(c.email || "");
    setOrganization(c.organization || "");
    setClientType(c.clientType || "person");
    setError(null);

    try {
      const detail = await clientsService.getClient(lawFirmId, c.id);
      if (requestId !== editRequestRef.current) return;
      setName(detail.name || c.name);
      setEmail(detail.email || "");
      setPhone(detail.phone || "");
      setOrganization(detail.organization || "");
      setAddress(detail.address || "");
      setPreferredContactMethod(detail.preferredContactMethod || "none");
      setClientType(detail.clientType || "person");
      setEditDetailLoaded(true);
    } catch (err) {
      if (requestId !== editRequestRef.current) return;
      setError(getErrorMessage(err, "Failed to load client details"));
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      dismissible={!submitting}
      labelledBy="attach-client-title"
      showClose={false}
      bodyClassName={null}
      portal={initialMode === "create"}
    >
          <div className="flex items-center justify-between px-6 py-4 shrink-0 border-b border-outline-subtle">
            <div className="flex items-center gap-2">
              {mode !== "search" && initialMode === "search" && (
                <button
                  type="button"
                  onClick={backToSearch}
                  className="p-1 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-hover cursor-pointer"
                  aria-label="Back to search"
                  title="Back to search"
                >
                  <ArrowLeft size={16} />
                </button>
              )}
              <h2 id="attach-client-title" className="text-base font-semibold text-on-surface">
                {mode === "search"
                  ? `Add Client to ${targetLabel}`
                  : mode === "edit"
                  ? "Edit Client"
                  : "Create New Client"}
              </h2>
            </div>
            <button
              onClick={onClose}
              disabled={submitting}
              className="text-on-surface-muted hover:text-on-surface-secondary focus:outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="px-6 pt-3 pb-1">
            <ErrorNotification error={error} />
          </div>

          {mode === "search" ? (
            <>
              <div className="px-6 pb-3 space-y-2">
                <TextInput
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search by name or email..."
                />
                <button
                  type="button"
                  onClick={() => switchToCreateMode(searchTerm.trim())}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-md border border-dashed border-outline hover:border-accent-emphasis hover:bg-surface-hover text-xs font-medium text-accent-emphasis transition-colors cursor-pointer"
                >
                  <Plus size={14} />
                  Create New Client {searchTerm.trim() ? `"${searchTerm.trim()}"` : ""}
                </button>
              </div>

              <div className="px-6 pb-6 overflow-y-auto overflow-x-hidden styled-scrollbar flex-1 min-h-0">
                {visibleClients.length === 0 ? (
                  <div className="text-center py-6">
                    <p className="text-sm text-on-surface-muted">
                      {searching
                        ? "Searching..."
                        : searchTerm.trim()
                          ? "No matching clients found."
                          : `No clients left to add to this ${targetLabel.toLowerCase()}.`}
                    </p>
                  </div>
                ) : (
                  <div className="rounded-lg border border-outline overflow-hidden">
                    {visibleClients.map((c) => {
                      const isCompany = c.clientType === "company";
                      return (
                        <div
                          key={c.id}
                          onClick={() => handleAddExistingClient(c.id, c.name)}
                          className="w-full flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-surface-hover transition-colors border-b border-outline-subtle last:border-b-0 cursor-pointer text-left"
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <div
                              className={`flex items-center justify-center h-8 w-8 rounded-full text-sm font-semibold shrink-0 ${
                                isCompany
                                  ? "bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300"
                                  : "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                              }`}
                            >
                              {isCompany ? (
                                <Building2 size={16} />
                              ) : (
                                c.name.charAt(0).toUpperCase()
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <p className="text-sm font-medium text-on-surface truncate">{c.name}</p>
                                {isCompany && (
                                  <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 shrink-0">
                                    Org
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-on-surface-secondary truncate">
                                {c.email || (isCompany ? "Organization Client" : "")}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => void switchToEditMode(c)}
                              className="p-1.5 rounded-md text-on-surface-muted hover:text-on-surface hover:bg-surface-alt transition-colors cursor-pointer"
                              aria-label="Edit Client"
                              title="Edit Client"
                            >
                              <Pencil size={15} />
                            </button>
                            <button
                              type="button"
                              disabled={submitting}
                              onClick={() => handleAddExistingClient(c.id, c.name)}
                              className="p-1.5 rounded-md text-accent-emphasis hover:bg-accent-solid/10 transition-colors cursor-pointer disabled:opacity-50"
                              aria-label={`Add to ${targetLabel}`}
                              title={`Add to ${targetLabel}`}
                            >
                              <Plus size={16} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {overflowNote && (
                  <p className="mt-2 text-xs text-on-surface-muted">{overflowNote}</p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 px-6 py-3 bg-surface-alt rounded-b-lg shrink-0">
                <Button type="secondary" onClick={onClose} disabled={submitting}>
                  Close
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="px-6 py-4 space-y-4 overflow-y-auto styled-scrollbar flex-1 min-h-0">
                {/* A client's type is fixed once it exists (clients_type_immutable),
                    so the edit view shows it rather than offering a change the
                    save could never make. */}
                {mode === "edit" ? (
                  <div>
                    <FieldLabel>Client Type</FieldLabel>
                    <p className="text-sm text-on-surface-secondary">
                      {clientType === "company" ? "Organization" : "Person"}
                    </p>
                  </div>
                ) : (
                  <Dropdown
                    label="Client Type"
                    value={clientType}
                    onChange={(v) => setClientType(v as "person" | "company")}
                    options={CLIENT_TYPE_OPTIONS}
                    portal
                  />
                )}

                <ClientFields lawFirmId={lawFirmId} idPrefix={fieldIds} clientType={clientType}
                  values={{ name, email, phone, organization, address, preferredContactMethod }}
                  nameRequired typedContactInputs preferredOwnLabel preferredUnwrapped preferredLabel="Preferred Contact Method"
                  duplicateName={duplicateClient?.label}
                  onSelectCompany={(company) => setLinkedCompanyId(company.id)}
                  onChange={(field, value) => {
                    const setters = { name: setName, email: setEmail, phone: setPhone, organization: setOrganization, address: setAddress, preferredContactMethod: setPreferredContactMethod };
                    setters[field](value);
                    if (field === "organization") setLinkedCompanyId(null);
                  }} />

                {mode === "create" && (clientType === "company" ? (
                  <p className="text-xs text-on-surface-muted">
                    Portal access for an organization is granted per contact, from the client&apos;s Contacts tab after creation.
                  </p>
                ) : email.trim() ? (
                  <Checkbox
                    checked={sendInvite}
                    onChange={setSendInvite}
                    label="Invite to client portal"
                    description="Send an email invite so they can log in."
                  />
                ) : (
                  <p className="text-xs text-on-surface-muted">
                    Add an email address above to invite this client to the portal.
                  </p>
                ))}
              </div>

              <div className="flex items-center justify-end gap-2 px-6 py-3 bg-surface-alt rounded-b-lg shrink-0">
                <Button type="secondary" onClick={() => initialMode === "create" ? onClose() : backToSearch()} disabled={submitting}>
                  Cancel
                </Button>
                <Button
                  type="primary"
                  onClick={mode === "edit" ? handleSaveEditedClient : handleCreateNewClient}
                  loading={submitting}
                  disabled={submitting || !name.trim() || (mode === "edit" && !editDetailLoaded)}
                >
                  {submitting
                    ? mode === "edit"
                      ? "Saving..."
                      : "Creating..."
                    : mode === "edit"
                    ? "Save & Add"
                    : "Create & Add"}
                </Button>
              </div>
            </>
          )}
    </Modal>
  );
}
