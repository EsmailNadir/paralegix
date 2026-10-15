"use client";

import ListSection from "@/components/ui/ListSection";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Archive, ArchiveRestore, Contact as ContactIcon } from 'lucide-react';
import Tooltip from "@/components/ui/Tooltip";
import { highlightText } from "@/components/ui/HighlightText";
import contactsService from "@/services/contacts.service";
import useContactsTable, { type ContactSortField } from "@/hooks/contactHooks/useContactsTable";
import { useContactTags } from "@/hooks/contactHooks/useContacts";
import type { Contact } from "@/types";
import ListView, { type ListRow, type ListSortColumn, type SortDir } from "@/components/ui/ListView";
import ContactCategoryBadge from "@/components/ui/ContactCategoryBadge";
import ClearFiltersButton from "@/components/ui/ClearFiltersButton";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Dropdown from "@/components/ui/Dropdown";
import EntityPicker from "@/components/ui/EntityPicker";
import ErrorNotification from "@/components/ErrorNotification";
import PageHeader from "@/components/ui/PageHeader";
import StatusBadge from "@/components/ui/StatusBadge";
import ListToolbar from "@/components/ui/ListToolbar";
import SearchInput from "@/components/ui/SearchInput";
import { CONTACT_CATEGORY_OPTIONS } from "@/constants/statusMeta";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { useNavigation } from "@/contexts/NavigationContext";
import { usePermissions } from "@/contexts/PermissionsContext";
import ContactFormModal from "./ContactFormModal";
import Button from "@/components/ui/Button";

interface Props {
  lawFirmId: string;
}

const ARCHIVED_OPTIONS = [
  { label: "Active", value: "false" },
  { label: "Archived", value: "true" },
  { label: "All", value: "all" },
];

const ONE_TIME_OPTIONS = [
  { label: "Hide one-time", value: "false" },
  { label: "One-time only", value: "true" },
  { label: "All", value: "all" },
];

/**
 * The firm-wide contact directory: every non-client party the firm deals with,
 * in one searchable list. Matters link to these records rather than holding
 * their own copy, so `matterCount` on a row is how many matters that contact is
 * currently on.
 */
export default function ContactsGrid({ lawFirmId }: Props) {
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const queryClient = useQueryClient();
  const canManage = hasPermission("contacts.manage");

  const {
    rows,
    total,
    loading,
    fetching,
    error: loadError,
    page,
    setPage,
    rowsPerPage,
    setRowsPerPage,
    search: searchTerm,
    setSearch: setSearchTerm,
    filters,
    setFilter,
    clearFilters,
    handleRequestSort,
  } = useContactsTable(lawFirmId);

  const { tags, loading: tagsLoading } = useContactTags(lawFirmId);

  useEffect(() => {
    if (!tagsLoading && filters.tag && !tags.includes(filters.tag)) {
      setFilter("tag", undefined);
    }
  }, [filters.tag, setFilter, tags, tagsLoading]);

  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<Contact | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["contacts", lawFirmId] }),
    [queryClient, lawFirmId],
  );

  const openCreate = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (contact: Contact) => { setEditing(contact); setFormOpen(true); };
  const requestDelete = (contact: Contact) => { setDeleteTarget(contact); setDeleteOpen(true); };
  const requestArchive = (contact: Contact) => { setArchiveTarget(contact); setArchiveOpen(true); };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);
    try {
      await contactsService.deleteContact(lawFirmId, deleteTarget.id);
      setDeleteOpen(false);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  };

  const confirmArchive = async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    setError(null);
    try {
      await contactsService.updateContact(lawFirmId, archiveTarget.id, { isArchived: true });
      setArchiveOpen(false);
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setArchiving(false);
    }
  };

  const restoreContact = async (contact: Contact) => {
    setError(null);
    try {
      await contactsService.updateContact(lawFirmId, contact.id, { isArchived: false });
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };

  const tagOptions = useMemo(
    () => [{ label: "All tags", value: "" }, ...tags.map((tag) => ({ label: tag, value: tag }))],
    [tags],
  );

  const categoryOptions = useMemo(
    () => [{ label: "All categories", value: "" }, ...CONTACT_CATEGORY_OPTIONS],
    [],
  );

  // `archived` defaults to hiding archived contacts, so it only counts as an
  // active filter when the user moved it off that default.
  const activeFilterCount =
    (filters.category ? 1 : 0) + (filters.tag ? 1 : 0) + (filters.matterId ? 1 : 0)
    + (filters.archived && filters.archived !== "false" ? 1 : 0)
    + (filters.oneTime && filters.oneTime !== "false" ? 1 : 0);

  const renderRow = useCallback((contact: Contact): ListRow => {
    const metaParts = [
      contact.title || null,
      contact.organization || null,
      contact.email || null,
      contact.phone || null,
      contact.matterCount ? `${contact.matterCount} matter${contact.matterCount === 1 ? "" : "s"}` : null,
    ].filter(Boolean);

    return {
      title: highlightText(contact.name || "Unnamed contact", searchTerm),
      badges: (
        <>
          <ContactCategoryBadge category={contact.category} />
          {contact.isArchived && (
            <StatusBadge variant="neutral">Archived</StatusBadge>
          )}
          {contact.oneTime && (
            <StatusBadge variant="neutral">One-time</StatusBadge>
          )}
        </>
      ),
      meta: highlightText(metaParts.length ? metaParts.join("  ·  ") : "No contact details", searchTerm),
    };
  }, [searchTerm]);

  // Ordering is done by the server, so the columns offered here are exactly the
  // fields its sort whitelist accepts (contacts.validation.js CONTACT_SORT_FIELDS).
  const sortColumns: ListSortColumn[] = useMemo(
    () => [
      { label: "Name", value: "name" },
      { label: "Category", value: "category" },
      { label: "Organization", value: "organization" },
      { label: "Email", value: "email" },
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
      handleRequestSort([{ field: value as ContactSortField, sort: dir }]);
    },
    [handleRequestSort],
  );

  return (
    <div className="min-h-screen bg-page">
      <div className="p-4 pl-5 md:p-6 max-w-[1600px] mx-auto space-y-6 min-w-0">
        <ErrorNotification error={error} onClose={() => setError(null)} />
        <ErrorNotification error={loadError} />

        <PageHeader
          eyebrow="Contact Management"
          title="Contacts"
          description="Opposing counsel, judges, experts, and everyone else your firm works with, shared across every matter."
          actions={
            <>
              {canManage && (
                <Button
                  size="compact"
                  onClick={openCreate}
                  icon={<Plus size={14} strokeWidth={2.2} />}
                >
                  New Contact
                </Button>
              )}
            </>
          }
        />

        <ListToolbar className="mb-4">
          <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center">
            <SearchInput
              className="w-full 2xl:min-w-64 2xl:max-w-sm 2xl:flex-1"
              placeholder="Search by name, organization, email, or phone..."
              value={searchTerm}
              onChange={(next) => setSearchTerm(next)}
              onClear={() => setSearchTerm("")}
            />
            <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap 2xl:ml-auto 2xl:justify-end">
              <Dropdown
                placeholder="All Categories"
                value={filters.category ?? ""}
                onChange={(v) => setFilter("category", v || undefined)}
                options={categoryOptions}
                className="w-full sm:w-40 text-sm"
              />
              <EntityPicker
                entity="matters"
                lawFirmId={lawFirmId}
                placeholder="All Matters"
                value={filters.matterId ?? ""}
                onChange={(v) => setFilter("matterId", v || undefined)}
                emptyOption={{ value: "", label: "All Matters" }}
                className="w-full sm:w-40 text-sm"
              />
              {tags.length > 0 && (
                <Dropdown
                  placeholder="All Tags"
                  value={filters.tag ?? ""}
                  onChange={(v) => setFilter("tag", v || undefined)}
                  options={tagOptions}
                  className="w-full sm:w-40 text-sm"
                />
              )}
              <Dropdown
                placeholder="Active"
                value={filters.archived ?? "false"}
                onChange={(v) => setFilter("archived", v === "false" ? undefined : v)}
                options={ARCHIVED_OPTIONS}
                className="w-full sm:w-32 text-sm"
              />
              <Dropdown
                placeholder="Hide one-time"
                value={filters.oneTime ?? "false"}
                onChange={(v) => setFilter("oneTime", v === "false" ? undefined : v)}
                options={ONE_TIME_OPTIONS}
                className="w-full sm:w-36 text-sm"
              />
            </div>
          </div>
          {activeFilterCount > 0 && (
            <div className="mt-3 flex justify-end">
              <ClearFiltersButton count={activeFilterCount} onClear={() => clearFilters()} />
            </div>
          )}
        </ListToolbar>

        <ListSection>
          <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
            <h2 className="text-lg font-semibold text-on-surface shrink-0">
              Contacts ({total})
            </h2>
          </div>

          <ListView<Contact>
            rows={rows}
            loading={loading}
            loadFailed={!!loadError}
            fetching={fetching}
            getRowId={(row) => row.id}
            renderRow={renderRow}
            onRowClick={(contact) => navigate(`/lawfirm/${lawFirmId}/contacts/${contact.id}`)}
            rowActions={
              canManage
                ? (contact) => (
                    <>
                      <Tooltip title="Edit" enterDelay={300}>
                        <button aria-label="Edit"
                          type="button"
                          onClick={() => openEdit(contact)}
                          className="rounded-md p-1.5 text-on-surface-secondary transition-[background-color,color,transform] hover:bg-surface-hover hover:text-on-surface active:scale-[0.96] motion-reduce:active:scale-100"
                        >
                          <Pencil size={15} />
                        </button>
                      </Tooltip>
                      <Tooltip title={contact.isArchived ? "Restore" : "Archive"} enterDelay={300}>
                        <button aria-label={contact.isArchived ? "Restore" : "Archive"}
                          type="button"
                          onClick={() => (contact.isArchived ? restoreContact(contact) : requestArchive(contact))}
                          className="rounded-md p-1.5 text-on-surface-secondary transition-[background-color,color,transform] hover:bg-surface-hover hover:text-on-surface active:scale-[0.96] motion-reduce:active:scale-100"
                        >
                          {contact.isArchived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                        </button>
                      </Tooltip>
                      <Tooltip title="Delete" enterDelay={300}>
                        <button aria-label="Delete"
                          type="button"
                          onClick={() => requestDelete(contact)}
                          className="rounded-md p-1.5 text-red-600 transition-[background-color,transform] hover:bg-red-500/10 active:scale-[0.96] motion-reduce:active:scale-100 dark:text-red-400"
                        >
                          <Trash2 size={15} />
                        </button>
                      </Tooltip>
                    </>
                  )
                : undefined
            }
            // Server-driven sort + pagination: the list renders just the current
            // server page and calls back to re-query on sort/page changes. ListView
            // pages are 0-based, the table hook's are 1-based.
            sortingMode="server"
            sortColumns={sortColumns}
            sortValue={sortValue}
            sortDir={sortDir}
            onSortChange={handleSortChange}
            paginationMode="server"
            page={page - 1}
            pageSize={rowsPerPage}
            rowCount={total}
            onPageChange={(p) => setPage(p + 1)}
            onPageSizeChange={setRowsPerPage}
            pageSizeOptions={[10, 25, 50]}
            defaultPageSize={rowsPerPage}
            emptyIcon={<ContactIcon size={40} />}
            emptyTitle="No contacts yet"
            emptyMessage="Add the opposing counsel, judges, and experts your firm works with, then link them to matters."
          />
        </ListSection>

        <ContactFormModal
          open={formOpen}
          onClose={() => setFormOpen(false)}
          onSaved={refresh}
          lawFirmId={lawFirmId}
          editing={editing}
        />

        <ConfirmModal
          isOpen={archiveOpen}
          onClose={() => setArchiveOpen(false)}
          onConfirm={confirmArchive}
          title="Archive Contact"
          message={
            archiveTarget?.matterCount
              ? `Are you sure you want to archive "${archiveTarget.name}"? They will be hidden from active lists, but will remain linked to ${archiveTarget.matterCount} matter${archiveTarget.matterCount === 1 ? "" : "s"}.`
              : `Are you sure you want to archive "${archiveTarget?.name ?? "this contact"}"? They will be hidden from active contact lists.`
          }
          confirmText="Archive"
          confirmType="primary"
          loading={archiving}
        />

        <ConfirmModal
          isOpen={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          onConfirm={confirmDelete}
          title="Delete Contact"
          message={
            deleteTarget?.matterCount
              ? `Delete "${deleteTarget.name}"? They will also be removed from ${deleteTarget.matterCount} matter${deleteTarget.matterCount === 1 ? "" : "s"}. Archive them instead to keep the matter history.`
              : `Delete "${deleteTarget?.name ?? "this contact"}"? This cannot be undone.`
          }
          confirmText="Delete"
          confirmType="danger"
          loading={deleting}
        />
      </div>
    </div>
  );
}
