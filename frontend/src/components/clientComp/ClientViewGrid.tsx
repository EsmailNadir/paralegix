"use client";

import ListSection from "@/components/ui/ListSection";

import { useId, useState, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import clientsService, { type LookupItem } from "@/services/clients.service";
import { useLinkedCompanyClient } from "@/hooks/clientHooks/useClients";
import useClientsTable, { type ClientSortField } from "@/hooks/clientHooks/useClientsTable";
import ErrorNotification from "@/components/ErrorNotification";
import SuccessNotification from "@/components/SuccessNotification";
import { useNavigation } from "@/contexts/NavigationContext";
import type { Client, ClientType, PreferredContactMethod } from "@/types";
import { Users, UserPlus, X, Trash2 } from 'lucide-react';
import ListView, { type ListRow, type ListSortColumn, type SortDir } from "@/components/ui/ListView";
import { DEFAULT_ROWS_PER_PAGE_OPTIONS } from "@/components/ui/ListPager";
import InlineWarning from "@/components/ui/InlineWarning";
import ActionIconButton from "@/components/ui/ActionIconButton";
import ClientStatusBadge from "@/components/ui/ClientStatusBadge";
import { CLIENT_STATUS_OPTIONS, STATUS_VARIANTS, clientStatusMeta } from "@/constants/statusMeta";
import Checkbox from "@/components/ui/Checkbox";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Dropdown from "@/components/ui/Dropdown";
import RowActionMenu from "@/components/ui/RowActionMenu";
import ListToolbar from "@/components/ui/ListToolbar";
import Button from "@/components/ui/Button";
import PageHeader from "@/components/ui/PageHeader";
import { usePermissions } from "@/contexts/PermissionsContext";
import { useLastOpenValue } from "@/hooks/useMountTransition";
import Modal from "@/components/ui/Modal";
import { getErrorMessage } from "@/lib/utils/apiErrors";

import { useDuplicateNameCheck } from "@/hooks/useEntityLookup";

import ClientFields from "@/components/clientComp/ClientFields";

import SearchInput from "@/components/ui/SearchInput";

type Props = {
  lawFirmId: string;
};

type NewClientForm = {
  clientType: ClientType;
  name: string;
  email: string;
  phone: string;
  organization: string;
  address: string;
  preferredContactMethod: string;
  inviteToPortal: boolean;
};

const EMPTY_FORM: NewClientForm = {
  clientType: "person",
  name: "",
  email: "",
  phone: "",
  organization: "",
  address: "",
  preferredContactMethod: "none",
  inviteToPortal: false,
};

const CLIENT_TYPE_OPTIONS = [
  { label: "Person", value: "person" },
  { label: "Organization", value: "company" },
];

const CLIENT_STATUS_FILTER_OPTIONS = [{ label: "All Statuses", value: "" }, ...CLIENT_STATUS_OPTIONS];

const CLIENT_TYPE_FILTER_OPTIONS = [
  { label: "All Types", value: "" },
  { label: "Person", value: "person" },
  { label: "Organization", value: "company" },
];

function hasDisplayableContactValue(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}

export default function ClientViewGrid({ lawFirmId }: Props) {
  const fieldIds = useId();
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const queryClient = useQueryClient();

  // The list is paged, searched and sorted by the server; `rows` is one page and
  // `total` is the full size of the matching set.
  const {
    rows: pagedClients,
    total: totalClients,
    loading,
    fetching,
    error: clientsError,
    page: currentPage,
    setPage: setCurrentPage,
    rowsPerPage,
    setRowsPerPage,
    search: searchTerm,
    setSearch: setSearchTerm,
    filters,
    setFilter,
    handleRequestSort,
    refetch: refetchClients,
  } = useClientsTable(lawFirmId);

  // Ordering is done by the server, so the columns offered here are exactly the
  // fields its sort whitelist accepts (clients.validation.ts CLIENT_SORT_FIELDS).
  const sortColumns: ListSortColumn[] = useMemo(
    () => [
      { label: "Name", value: "name" },
      { label: "Email", value: "email" },
      { label: "Organization", value: "organization" },
      { label: "Added", value: "createdAt", defaultDir: "desc" },
    ],
    [],
  );

  const [sortValue, setSortValue] = useState<string>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const handleSortChange = useCallback(
    (value: string, dir: SortDir) => {
      setSortValue(value);
      setSortDir(dir);
      handleRequestSort([{ field: value as ClientSortField, sort: dir }]);
    },
    [handleRequestSort],
  );

  const [error, setError] = useState<string | null>(null);
  // Track whether the user has dismissed the react-query load error. Without
  // this, clicking close on the banner only cleared the local `error` while
  // `clientsError` stayed set, so the banner immediately re-appeared.
  const [clientsErrorDismissed, setClientsErrorDismissed] = useState(false);
  const showingLoadError = !!clientsError && !clientsErrorDismissed;
  const displayedError = error || (showingLoadError ? clientsError : null);

  // Only offered while the banner is showing the LOAD failure: an action failure
  // (a client that could not be removed) is not fixed by fetching the list again.
  const [retryingLoad, setRetryingLoad] = useState(false);
  const retryLoad = useCallback(async () => {
    setRetryingLoad(true);
    try {
      await refetchClients();
    } finally {
      setRetryingLoad(false);
    }
  }, [refetchClients]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [form, setForm] = useState<NewClientForm>(EMPTY_FORM);
  const { duplicate: duplicateClient } = useDuplicateNameCheck("clients", lawFirmId, form.name, {
    enabled: showAddModal,
  });
  // Whatever real company client the Organization field currently names, so
  // "Create Client" can link the new person to it automatically. No
  // confirmation here (unlike the edit-form Save flow): creating is purely
  // additive, there's no existing relationship a mistake could sever.
  const { company: formOrgCompanyMatch } = useLinkedCompanyClient(
    lawFirmId,
    form.clientType !== "company" ? form.organization : "",
  );
  // The new relationship's flags, editable inline once a company match shows
  // up, same fields the edit-form's Organization relationship section exposes for
  // an existing link. Receives emails / Can view billing default on for a
  // freshly created relationship; Primary contact defaults off since it's
  // exclusive per company and shouldn't silently bump an existing primary.
  const [newRelationshipFlags, setNewRelationshipFlags] = useState({
    isPrimary: false,
    isEmailRecipient: true,
    canViewBilling: true,
  });
  const [addingClient, setAddingClient] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  // When a client is created but the portal invite email fails to send the
  // backend returns portalStatus 'invite_failed'. Surface it as a distinct
  // warning with a "Resend invite" action (vs. the generic success banner) so
  // the firm knows the invite didn't go out.
  const [inviteFailed, setInviteFailed] = useState<{ clientId: string; name: string } | null>(null);
  const [resendingInvite, setResendingInvite] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Client | null>(null);
  const [removing, setRemoving] = useState(false);
  // Which client's status is mid-save, so the "Change Status" modal's Save
  // button can show a spinner without blocking every other row's menu.
  const [statusUpdatingId, setStatusUpdatingId] = useState<string | null>(null);
  // The client the "Change Status" modal is open for, and the value picked in
  // it.
  const [statusTarget, setStatusTarget] = useState<Client | null>(null);
  const [statusValue, setStatusValue] = useState<string>("active");
  // Holds the last non-null target through the exit animation so the modal's
  // content doesn't blank out to "this client" mid close.
  const shownStatusTarget = useLastOpenValue(!!statusTarget, statusTarget);
  const closeStatusModal = useCallback(() => setStatusTarget(null), []);

  const openAddModal = () => {
    setForm(EMPTY_FORM);
    setAddError(null);
    setNewRelationshipFlags({ isPrimary: false, isEmailRecipient: true, canViewBilling: true });
    setShowAddModal(true);
  };

  const closeAddModal = () => {
    // Form is reset in openAddModal; leaving it intact here keeps the modal
    // content stable while the close animation plays.
    setShowAddModal(false);
  };

  const performAddClient = async (linkCompany: LookupItem | null) => {
    if (addingClient) return;

    setAddingClient(true);
    setAddError(null);
    try {
      const hasEmail = !!form.email.trim();
      const contactMethod = form.preferredContactMethod;
      const validContactMethods = ["email", "phone", "sms", "portal"];

      const result = await clientsService.createClient(lawFirmId, {
        clientType: form.clientType,
        name: form.name.trim(),
        email: hasEmail ? form.email.trim() : undefined,
        phone: form.phone.trim() || undefined,
        // Field is hidden once Company is selected (see the input above), but the
        // value can still be sitting in state from before the user switched - drop
        // it the same defensive way portalInvitePending below does, so toggling
        // Person -> Company can't silently submit a stale employer string.
        organization: form.clientType !== "company" ? (form.organization.trim() || undefined) : undefined,
        address: form.address.trim() || undefined,
        // "None" goes out as null so the client is stored with no preference;
        // leaving the field out would take the server's 'email' default.
        preferredContactMethod: contactMethod && validContactMethods.includes(contactMethod) ? (contactMethod as PreferredContactMethod) : null,
        // A company can't carry clients.userId directly. Portal access for one
        // lives on its roster instead, granted per contact after creation.
        portalInvitePending: form.clientType !== "company" && form.inviteToPortal && hasEmail,
      });

      const addedName = form.name.trim();
      closeAddModal();

      // Best-effort: the client row above is already created either way, so a
      // failure here shouldn't read as the whole action having failed. It just
      // means the Organization field stays a free-text label until someone
      // links them manually from their own page (Overview > Edit).
      let linkFailure: string | null = null;
      if (linkCompany) {
        try {
          await clientsService.createClientContact(lawFirmId, linkCompany.id, {
            personClientId: result.clientId,
            isPrimary: newRelationshipFlags.isPrimary,
            isEmailRecipient: newRelationshipFlags.isEmailRecipient,
            canViewBilling: newRelationshipFlags.canViewBilling,
          });
        } catch (linkErr) {
          linkFailure = getErrorMessage(linkErr, `Failed to link ${addedName} to ${linkCompany.label}`);
        }
      }

      if (result.portalStatus === "added") {
        setInviteFailed(null);
        setSuccessMessage(`${addedName} has been added and connected to the client portal.`);
      } else if (result.portalStatus === "invited") {
        setInviteFailed(null);
        setSuccessMessage(`${addedName} has been added and invited to the client portal.`);
      } else if (result.portalStatus === "invite_failed") {
        // The client row was created, but the invite email failed. Show a warning
        // (not a success) and offer a resend, rather than implying the invite went out.
        setSuccessMessage(null);
        setInviteFailed({ clientId: result.clientId, name: addedName });
      } else if (linkCompany) {
        setInviteFailed(null);
        setSuccessMessage(
          linkFailure
            ? `${addedName} has been added to your law firm, but linking them to ${linkCompany.label} failed: ${linkFailure}`
            : `${addedName} has been added to your law firm and linked to ${linkCompany.label}.`,
        );
      } else {
        setInviteFailed(null);
        setSuccessMessage(`${addedName} has been added to your law firm.`);
      }

      // Refresh client list via react-query cache
      queryClient.invalidateQueries({ queryKey: ["clients", lawFirmId] });
    } catch (err) {
      let message = "Failed to add client";
      if (err instanceof Error) {
        const details = (err as { details?: unknown }).details;
        if (details && typeof details === "object") {
          const source = (details as Record<string, unknown>).fieldErrors ?? details;
          const msgs = Object.values(source as Record<string, unknown>)
            .flat()
            .filter((v): v is string => typeof v === "string");
          if (msgs.length > 0) {
            message = msgs[0];
          } else {
            message = err.message;
          }
        } else {
          message = err.message;
        }
      }
      setAddError(message);
    } finally {
      setAddingClient(false);
    }
  };

  const onAddClient = () => {
    if (!form.name.trim()) {
      setAddError("Client name is required.");
      return;
    }
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setAddError("Please enter a valid email address.");
      return;
    }
    void performAddClient(formOrgCompanyMatch);
  };

  const onResendInvite = async () => {
    if (!inviteFailed || resendingInvite) return;
    setResendingInvite(true);
    setError(null);
    try {
      await clientsService.resendClientInvitation(lawFirmId, inviteFailed.clientId);
      const name = inviteFailed.name;
      setInviteFailed(null);
      setSuccessMessage(`Invite resent to ${name}.`);
      queryClient.invalidateQueries({ queryKey: ["clients", lawFirmId] });
    } catch (err) {
      setError(getErrorMessage(err, "Failed to resend invite"));
    } finally {
      setResendingInvite(false);
    }
  };

  const onRemoveClient = async () => {
    if (!removeTarget) return;
    try {
      setRemoving(true);
      setError(null);
      await clientsService.deleteClient(lawFirmId, removeTarget.id);
      queryClient.invalidateQueries({ queryKey: ["clients", lawFirmId] });
      setSuccessMessage(`${removeTarget.name || "Client"} has been removed.`);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to remove client"));
    } finally {
      setRemoving(false);
      setRemoveTarget(null);
    }
  };

  const onChangeClientStatus = async (client: Client, status: string) => {
    if (status === client.status || statusUpdatingId) return;
    setStatusUpdatingId(client.id);
    setError(null);
    try {
      await clientsService.updateClient(lawFirmId, client.id, { status: status as Client["status"] });
      queryClient.invalidateQueries({ queryKey: ["clients", lawFirmId] });
      setSuccessMessage(`${client.name || "Client"} marked ${clientStatusMeta(status).label.toLowerCase()}.`);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to update client status"));
    } finally {
      setStatusUpdatingId(null);
    }
  };

  const onSaveStatus = async () => {
    if (!statusTarget) return;
    await onChangeClientStatus(statusTarget, statusValue);
    setStatusTarget(null);
  };

  // One row of the list. The page, search and sort are the server's, so this only
  // draws what a row says. Counts come from the client row itself (`matterIds`
  // aggregated from matter_clients, `taskCount` from the list endpoint), so they
  // stay correct on every page without loading the firm's whole task list.
  const renderRow = useCallback((client: Client): ListRow => {
    const organizations = client.clientType !== "company" ? client.companyNames ?? [] : [];
    const metaParts = [
      hasDisplayableContactValue(client.email) ? client.email : null,
      hasDisplayableContactValue(client.phone) ? client.phone : null,
      organizations.length === 1
        ? `Organization: ${organizations[0]}`
        : organizations.length > 1
          ? `Organizations: ${organizations.length}`
          : null,
    ].filter(Boolean);

    const matterCount = client.matterIds?.length ?? 0;
    const counts = [
      `${matterCount} matter${matterCount !== 1 ? "s" : ""}`,
      client.taskCount != null ? `${client.taskCount} task${client.taskCount !== 1 ? "s" : ""}` : null,
      client.clientType === "company" && client.contactCount != null
        ? `${client.contactCount} contact${client.contactCount !== 1 ? "s" : ""}`
        : null,
    ].filter(Boolean);

    return {
      title: client.name || "Unnamed",
      badges: <ClientStatusBadge status={client.status} className="shrink-0" />,
      meta: metaParts.length ? metaParts.join("  ·  ") : "No contact details",
      right: <span className="text-xs text-on-surface-muted">{counts.join("  ·  ")}</span>,
    };
  }, []);

  return (
    <div className="min-h-screen bg-page">
      <div className="p-4 pl-5 md:p-6 max-w-[1600px] mx-auto space-y-6 min-w-0">
        <ErrorNotification
          error={displayedError}
          onClose={() => {
            setError(null);
            setClientsErrorDismissed(true);
          }}
          onRetry={showingLoadError ? retryLoad : undefined}
          retrying={retryingLoad}
        />

        {/* Page Header */}
        <PageHeader
          eyebrow="Client Management"
          title="Clients"
          description={
            <>
              View and manage your law firm&apos;s clients.
              {totalClients > 0 && !searchTerm.trim() && (
                <>
                  {" "}You have <span className="font-semibold text-on-surface">{totalClients} client{totalClients !== 1 ? "s" : ""}</span>.
                </>
              )}
            </>
          }
          actions={
            hasPermission("clients.manage") && (
              <Button
                size="compact"
                onClick={() => {
                  setSuccessMessage(null);
                  openAddModal();
                }}
                icon={<UserPlus size={14} strokeWidth={2.2} />}
              >
                New Client
              </Button>
            )
          }
        />

        <SuccessNotification message={successMessage} onClose={() => setSuccessMessage(null)} />

        {/* Invite-failed warning (client created, invite email failed to send) */}
        {inviteFailed && (
          <InlineWarning>
            {inviteFailed.name} was added, but the portal invite email could not be sent. You can resend it now.{" "}
            <span className="ml-2 inline-flex items-center gap-2 align-middle">
              <Button type="secondary" size="small" onClick={onResendInvite} loading={resendingInvite}>
                Resend invite
              </Button>
              <ActionIconButton label="Dismiss" size="sm" onClick={() => setInviteFailed(null)}>
                <X size={14} />
              </ActionIconButton>
            </span>
          </InlineWarning>
        )}

        <ListToolbar className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
          <SearchInput
            className="w-full md:min-w-64 md:max-w-sm md:flex-1"
            placeholder="Search by client name or email..."
            value={searchTerm}
            onChange={(next) => {
              // The table hook debounces the term and resets to page 1 itself.
              setSearchTerm(next);
            }}
            onClear={() => setSearchTerm("")}
          />
          <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap md:ml-auto md:justify-end">
            <Dropdown
              placeholder="All Types"
              value={filters.clientType ?? ""}
              onChange={(v) => setFilter("clientType", v || undefined)}
              options={CLIENT_TYPE_FILTER_OPTIONS}
              className="w-full sm:w-36 text-sm"
            />
            <Dropdown
              placeholder="All Statuses"
              value={filters.status ?? ""}
              onChange={(v) => setFilter("status", v || undefined)}
              options={CLIENT_STATUS_FILTER_OPTIONS}
              className="w-full sm:w-40 text-sm"
            />
          </div>
        </ListToolbar>

        <ListSection>
          <h2 className="text-lg font-semibold text-on-surface">Clients ({totalClients})</h2>

          <ListView<Client>
            loadFailed={!!clientsError}
            rows={pagedClients}
            loading={loading}
            fetching={fetching}
            showFetchIndicator={false}
            getRowId={(client) => client.id}
            renderRow={renderRow}
            onRowClick={(client) => navigate(`/lawfirm/${lawFirmId}/clients/${client.id}`)}
            sortingMode="server"
            sortColumns={sortColumns}
            sortValue={sortValue}
            sortDir={sortDir}
            onSortChange={handleSortChange}
            rowActions={
              hasPermission("clients.manage")
                ? (client) => (
                    <RowActionMenu
                      ariaLabel={`Actions for ${client.name || "client"}`}
                      actions={[
                        {
                          label: clientStatusMeta(client.status).label,
                          icon: (
                            <span
                              className={`inline-block size-2 rounded-full ${STATUS_VARIANTS[clientStatusMeta(client.status).variant].dot}`}
                            />
                          ),
                          onClick: () => {
                            setStatusTarget(client);
                            setStatusValue(client.status ?? "active");
                          },
                        },
                        {
                          label: "Remove",
                          icon: <Trash2 size={14} />,
                          danger: true,
                          onClick: () => setRemoveTarget(client),
                        },
                      ]}
                    />
                  )
                : undefined
            }
            // Server-driven pagination: the list renders just the current server
            // page and calls back to re-query on a page change. ListView pages are
            // 0-based, the table hook's are 1-based.
            paginationMode="server"
            page={currentPage - 1}
            pageSize={rowsPerPage}
            rowCount={totalClients}
            onPageChange={(p) => setCurrentPage(p + 1)}
            onPageSizeChange={setRowsPerPage}
            pageSizeOptions={DEFAULT_ROWS_PER_PAGE_OPTIONS}
            defaultPageSize={rowsPerPage}
            emptyIcon={<Users size={40} />}
            emptyTitle={searchTerm ? "No clients match your search" : "No clients yet"}
            emptyMessage={
              searchTerm
                ? "Try a different search term."
                : "Add clients to your matters to see them here."
            }
          />
        </ListSection>

        {/* Change Status */}
        <Modal
          isOpen={!!statusTarget}
          onClose={closeStatusModal}
          title="Change Status"
          size="md"
          closeIcon={<X size={18} />}
          bodyClassName="px-6 py-5"
          footer={
            <>
              <Button type="secondary" onClick={closeStatusModal}>
                Cancel
              </Button>
              <Button
                type="primary"
                onClick={onSaveStatus}
                loading={statusUpdatingId === statusTarget?.id}
                disabled={statusUpdatingId === statusTarget?.id}
              >
                {statusUpdatingId === statusTarget?.id ? "Saving..." : "Save"}
              </Button>
            </>
          }
        >
          <p className="text-sm text-on-surface-secondary mb-3">
            For {shownStatusTarget?.name || "this client"}
          </p>
          <Dropdown
            label="Status"
            value={statusValue}
            onChange={setStatusValue}
            options={CLIENT_STATUS_OPTIONS}
            className="text-sm"
            portal
          />
        </Modal>

        {/* Remove Client Confirmation */}
        <ConfirmModal
          isOpen={!!removeTarget}
          onClose={() => setRemoveTarget(null)}
          onConfirm={onRemoveClient}
          title="Remove Client"
          message={`Are you sure you want to remove ${removeTarget?.name || "this client"} from your law firm? This will remove them from all associated matters and cannot be undone.`}
          confirmText={removing ? "Removing..." : "Remove Client"}
        />

        {/* Add Client Modal */}
        <Modal
          isOpen={showAddModal}
          onClose={closeAddModal}
          title="Add Client"
          size="lg"
          closeIcon={<X size={18} />}
          footer={
            <>
              <Button type="secondary" onClick={closeAddModal}>
                Cancel
              </Button>
              <Button
                type="primary"
                onClick={onAddClient}
                loading={addingClient}
                disabled={addingClient || !form.name.trim()}
              >
                {addingClient ? "Adding..." : "Add Client"}
              </Button>
            </>
          }
        >
          <ErrorNotification error={addError} onClose={() => setAddError(null)} />

          {/* Client type: immutable once created */}
          <Dropdown
            label="Client Type"
            value={form.clientType}
            onChange={(v) => setForm((f) => ({ ...f, clientType: v as ClientType }))}
            options={CLIENT_TYPE_OPTIONS}
            portal
          />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <ClientFields lawFirmId={lawFirmId} idPrefix={fieldIds} values={form} clientType={form.clientType}
              nameId={`${fieldIds}-form`} nameAutoFocus typedContactInputs addressClassName="md:col-span-2"
              preferredOwnLabel duplicateName={duplicateClient?.label}
              onChange={(field, value) => setForm((f) => ({ ...f, [field]: value }))}
              afterOrganization={<>
{/* Shows automatically once Organization matches a real company client -
                this person will be linked to it on create (see performAddClient),
                so these flags can be set up front instead of a separate edit
                afterward. Same three fields as an existing relationship's editor
                on that person's own Overview tab, but defaulted for a brand-new
                relationship rather than mirroring a persisted one. */}
            {formOrgCompanyMatch && (
              <div className="md:col-span-2 rounded-lg border border-outline-subtle bg-surface-alt p-3 space-y-3">
                <div>
                  <p className="text-xs font-medium text-on-surface">Organization relationship</p>
                  <p className="text-xs text-on-surface-muted mt-0.5">
                    Will be linked to {formOrgCompanyMatch.label} on create.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <label className="inline-flex items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs text-on-surface">
                    <Checkbox
                      checked={newRelationshipFlags.isPrimary}
                      onChange={(value) => setNewRelationshipFlags((f) => ({ ...f, isPrimary: value }))}
                    />
                    Primary contact
                  </label>
                  <label className="inline-flex items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs text-on-surface">
                    <Checkbox
                      checked={newRelationshipFlags.isEmailRecipient}
                      onChange={(value) => setNewRelationshipFlags((f) => ({ ...f, isEmailRecipient: value }))}
                    />
                    Receives emails
                  </label>
                  <label className="inline-flex items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 py-2 text-xs text-on-surface">
                    <Checkbox
                      checked={newRelationshipFlags.canViewBilling}
                      onChange={(value) => setNewRelationshipFlags((f) => ({ ...f, canViewBilling: value }))}
                    />
                    Can view billing
                  </label>
                </div>
              </div>
            )}
              </>} />
          </div>

          {/* Invite to portal checkbox: a company can't carry a portal
              login directly. Its contacts are invited individually from
              the client's Contacts tab after it's created. */}
          <div className="pt-1 space-y-1">
            {form.clientType === "company" ? (
              <p className="text-xs text-on-surface-muted">
                Portal access for an organization is granted per contact, from the client&apos;s Contacts tab after it&apos;s created.
              </p>
            ) : form.email.trim() ? (
              <>
                <Checkbox
                  checked={form.inviteToPortal}
                  onChange={(checked) => setForm((f) => ({ ...f, inviteToPortal: checked }))}
                  label="Invite to client portal"
                />
                {form.inviteToPortal && (
                  <p className="text-xs text-on-surface-muted pl-6.5">
                    An email will be sent to {form.email.trim()} inviting them to create a Paralegix client portal account.
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-on-surface-muted">
                Add an email above to invite this client to the portal.
              </p>
            )}
          </div>
        </Modal>
      </div>
    </div>
  );
}
