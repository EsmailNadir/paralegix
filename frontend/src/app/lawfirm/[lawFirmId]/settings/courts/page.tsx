'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import courtsService from '@/services/courts.service';
import type { Court } from '@/types/court';
import { AutoPager } from '@/components/ui/ListPager';
import usePagedRows from '@/hooks/usePagedRows';
import Button from '@/components/ui/Button';
import ConfirmModal from '@/components/ui/ConfirmModal';
import ErrorNotification from '@/components/ErrorNotification';
import CourtCatalogPickerModal from '@/components/courtsComp/CourtCatalogPickerModal';
import CourtNameAutocomplete, { formatCourtCatalogValue } from '@/components/courtsComp/CourtNameAutocomplete';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useNavigation } from '@/contexts/NavigationContext';
import { validateRequiredFields, ValidationField } from '@/utils/formValidation';
import { useQuery } from '@tanstack/react-query';
import contactsService from '@/services/contacts.service';
import type { Contact } from '@/types';
import { Library, Gavel } from 'lucide-react';
import PanelLoadingSpinner from '@/components/ui/PanelLoadingSpinner';
import SectionLabel from '@/components/ui/SectionLabel';

/** "trial" -> "Trial", "bankruptcy_panel" -> "Bankruptcy Panel". */
const titleCase = (s?: string | null) =>
  (s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export default function CourtsPage() {
  const params = useParams();
  const id = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string);
  const lawFirmId = id;
  const { hasPermission } = usePermissions();
  const { navigate } = useNavigation();
  const canManageCourts = hasPermission('courts.manage');
  const canViewContacts = hasPermission('contacts.view');

  // Every contact tied to a court, in one read, grouped by court. One request
  // per visible court would be dozens on a multi-state practice.
  const { data: courtContacts = [] } = useQuery<Contact[]>({
    queryKey: ['contacts', lawFirmId, 'byCourt'],
    queryFn: async () => {
      const { contacts } = await contactsService.listContactsPaged(lawFirmId, {
        hasCourt: true,
        limit: 500,
      });
      return contacts;
    },
    enabled: !!lawFirmId && canViewContacts,
    staleTime: 60_000,
  });

  const contactsByCourt = useMemo(() => {
    const grouped = new Map<string, Contact[]>();
    for (const contact of courtContacts) {
      if (!contact.courtId) continue;
      const list = grouped.get(contact.courtId) || [];
      list.push(contact);
      grouped.set(contact.courtId, list);
    }
    return grouped;
  }, [courtContacts]);

  const [name, setName] = useState('');
  const [abbreviation, setAbbreviation] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [address, setAddress] = useState('');
  const [courtType, setCourtType] = useState('');
  const [list, setList] = useState<Court[]>([]);

  // A multi-state practice tracks dozens to hundreds of courts, so the
  // rendered rows are windowed.
  const listPager = usePagedRows(list, 25);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [courtToDelete, setCourtToDelete] = useState<Court | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [editingAbbreviation, setEditingAbbreviation] = useState('');
  const [editingCity, setEditingCity] = useState('');
  const [editingState, setEditingState] = useState('');
  const [editingAddress, setEditingAddress] = useState('');
  const [editingCourtType, setEditingCourtType] = useState('');
  const [updating, setUpdating] = useState(false);

  // Court-directory (catalog) picker
  const [showCatalog, setShowCatalog] = useState(false);

  const load = useCallback(async () => {
    if (!lawFirmId) return;
    // Every courts route, the list included, requires courts.manage, so a
    // member without it gets the notice below instead of a refused read.
    if (!canManageCourts) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await courtsService.listCourts(lawFirmId);
      setList(res.courts || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load courts');
    } finally {
      setLoading(false);
    }
  }, [lawFirmId, canManageCourts]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch: courts list/loading/error state set as the request progresses
    load();
  }, [load]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lawFirmId || !canManageCourts) return;

    const validationFields: ValidationField[] = [
      { name: 'name', value: name, required: true, label: 'Name' }
    ];

    const validationError = validateRequiredFields(validationFields);
    if (validationError) {
      setError(validationError);
      return;
    }

    setCreating(true);
    setError(null);
    try {
      await courtsService.createCourt(lawFirmId, {
        name: name.trim(),
        ...(abbreviation.trim() ? { abbreviation: abbreviation.trim() } : {}),
        ...(city.trim() ? { city: city.trim() } : {}),
        ...(state.trim() ? { state: state.trim() } : {}),
        ...(address.trim() ? { address: address.trim() } : {}),
        ...(courtType.trim() ? { courtType: courtType.trim() } : {}),
      });
      setName('');
      setAbbreviation('');
      setCity('');
      setState('');
      setAddress('');
      setCourtType('');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to create court');
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (!lawFirmId || !canManageCourts || !courtToDelete) return;
    const courtId = courtToDelete.id;
    setDeletingId(courtId);
    setDeleteError(null);
    try {
      await courtsService.deleteCourt(lawFirmId, courtId);
      setCourtToDelete(null);
      await load();
    } catch (e: any) {
      setDeleteError(e?.message || 'Failed to delete court');
    } finally {
      setDeletingId(null);
    }
  };

  const startEdit = (court: Court) => {
    if (!canManageCourts) return;
    setEditingId(court.id);
    setEditingName(court.name);
    setEditingAbbreviation(court.abbreviation || '');
    setEditingCity(court.city || '');
    setEditingState(court.state || '');
    setEditingAddress(court.address || '');
    setEditingCourtType(court.courtType || '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingName('');
    setEditingAbbreviation('');
    setEditingCity('');
    setEditingState('');
    setEditingAddress('');
    setEditingCourtType('');
  };

  const onUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lawFirmId || !editingId || !canManageCourts) return;

    const validationFields: ValidationField[] = [
      { name: 'name', value: editingName, required: true, label: 'Name' }
    ];

    const validationError = validateRequiredFields(validationFields);
    if (validationError) {
      setError(validationError);
      return;
    }

    setUpdating(true);
    setError(null);
    try {
      await courtsService.updateCourt(lawFirmId, editingId, {
        name: editingName.trim(),
        // null clears a field the user emptied; the server leaves an omitted
        // field as it was.
        abbreviation: editingAbbreviation.trim() || null,
        city: editingCity.trim() || null,
        state: editingState.trim() || null,
        address: editingAddress.trim() || null,
        courtType: editingCourtType.trim() || null,
      });
      cancelEdit();
      await load();
    } catch (e: any) {
      setError(e?.message || 'Failed to update court');
    } finally {
      setUpdating(false);
    }
  };

  if (!lawFirmId) return null;

  const inputClass =
    'rounded-lg border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';

  return (
    <div className="p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <SectionLabel gap="1">Courts</SectionLabel>
          <p className="text-sm text-on-surface-secondary">
            Manage the courts your firm files matters in. Courts can be assigned to matters and tasks for better organization.
          </p>
        </div>
        {canManageCourts && (
          <Button
            type="secondary"
            size="small"
            onClick={() => setShowCatalog(true)}
            className="shrink-0 inline-flex items-center gap-1.5"
          >
            <Library size={14} /> Browse directory
          </Button>
        )}
      </div>

      <ErrorNotification
        error={error}
        onClose={() => setError(null)}
        className="mt-4"
      />

      {!canManageCourts && (
        <div className="mt-4 rounded-lg border border-outline bg-surface-alt px-4 py-3 text-sm text-on-surface-secondary">
          You need <code>courts.manage</code> permission to create, edit, or delete courts.
        </div>
      )}

      <form onSubmit={onCreate} className="mt-6 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <CourtNameAutocomplete
            value={name}
            onChange={setName}
            onSelect={(court) => {
              setName(court.fullName);
              setAbbreviation(court.citationAbbrev || court.shortName || '');
              setState(court.state || '');
              setCourtType(formatCourtCatalogValue(court.courtType));
            }}
            lawFirmId={lawFirmId}
            containerClassName="flex-1 min-w-[200px] max-w-md"
            className={`w-full ${inputClass}`}
            disabled={!canManageCourts || creating}
          />
          <input
            type="text"
            value={abbreviation}
            onChange={(e) => setAbbreviation(e.target.value)}
            placeholder="Abbreviation (e.g. SCOTUS)"
            className={`w-48 ${inputClass}`}
            disabled={!canManageCourts || creating}
            maxLength={50}
          />
          <Button
            type="primary"
            htmlType="submit"
            disabled={!canManageCourts || creating || !name.trim()}
            loading={creating}
          >
            Add
          </Button>
        </div>
        <div className="flex gap-3 flex-wrap">
          <input
            type="text"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="City"
            className={`w-40 ${inputClass}`}
            disabled={!canManageCourts || creating}
          />
          <input
            type="text"
            value={state}
            onChange={(e) => setState(e.target.value)}
            placeholder="State / Province"
            className={`w-40 ${inputClass}`}
            disabled={!canManageCourts || creating}
          />
          <input
            type="text"
            value={courtType}
            onChange={(e) => setCourtType(e.target.value)}
            placeholder="Type (e.g. Federal, State)"
            className={`w-48 ${inputClass}`}
            disabled={!canManageCourts || creating}
          />
        </div>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Address (optional)"
          className={`w-full max-w-md ${inputClass}`}
          disabled={!canManageCourts || creating}
        />
      </form>

      {canManageCourts && <div className="mt-6">
        {loading ? (
          <PanelLoadingSpinner label="Loading courts" />
        ) : list.length === 0 ? (
          <p className="text-sm text-on-surface-secondary">No courts yet.</p>
        ) : (
          <ul className="rounded-xl border border-outline overflow-hidden divide-y divide-outline-subtle">
            {listPager.pagedRows.map((court) => (
              <li key={court.id} className="px-4 py-3 bg-surface">
                {editingId === court.id ? (
                  <form onSubmit={onUpdate} className="space-y-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <input
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        className={`flex-1 min-w-[200px] ${inputClass}`}
                        autoFocus
                        placeholder="Court name"
                      />
                      <input
                        type="text"
                        value={editingAbbreviation}
                        onChange={(e) => setEditingAbbreviation(e.target.value)}
                        placeholder="Abbreviation"
                        className={`w-48 ${inputClass}`}
                        maxLength={50}
                      />
                    </div>
                    <div className="flex gap-3 flex-wrap">
                      <input
                        type="text"
                        value={editingCity}
                        onChange={(e) => setEditingCity(e.target.value)}
                        placeholder="City"
                        className={`w-40 ${inputClass}`}
                      />
                      <input
                        type="text"
                        value={editingState}
                        onChange={(e) => setEditingState(e.target.value)}
                        placeholder="State / Province"
                        className={`w-40 ${inputClass}`}
                      />
                      <input
                        type="text"
                        value={editingCourtType}
                        onChange={(e) => setEditingCourtType(e.target.value)}
                        placeholder="Type"
                        className={`w-48 ${inputClass}`}
                      />
                    </div>
                    <input
                      type="text"
                      value={editingAddress}
                      onChange={(e) => setEditingAddress(e.target.value)}
                      placeholder="Address"
                      className={`w-full max-w-md ${inputClass}`}
                    />
                    {canManageCourts && (
                      <div className="flex gap-2">
                        <Button
                          type="primary"
                          htmlType="submit"
                          size="small"
                          disabled={updating || !editingName.trim()}
                          loading={updating}
                        >
                          Save
                        </Button>
                        <Button
                          type="secondary"
                          size="small"
                          onClick={cancelEdit}
                          disabled={updating}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </form>
                ) : (
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="font-medium text-on-surface">{court.name}</div>
                        {court.abbreviation && (
                          <span className="inline-flex items-center rounded-full bg-surface-alt px-2 py-0.5 text-[10px] font-medium text-on-surface-muted border border-outline-subtle">
                            {court.abbreviation}
                          </span>
                        )}
                        {court.courtType && (
                          <span className="inline-flex items-center rounded-full bg-surface-alt px-2 py-0.5 text-[10px] font-medium text-on-surface-muted border border-outline-subtle">
                            {titleCase(court.courtType)}
                          </span>
                        )}
                      </div>
                      {(court.city || court.state) && (
                        <div className="text-xs text-on-surface-secondary mt-0.5">
                          {[court.city, court.state].filter(Boolean).join(', ')}
                        </div>
                      )}
                      {court.address && (
                        <div className="text-xs text-on-surface-muted mt-0.5">{court.address}</div>
                      )}
                      {/* The judges and clerks this firm has recorded at this
                          court, from the contact directory. */}
                      {(contactsByCourt.get(court.id)?.length ?? 0) > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                          <Gavel size={12} className="text-on-surface-muted shrink-0" />
                          {contactsByCourt.get(court.id)!.map((contact) => (
                            <button
                              key={contact.id}
                              type="button"
                              onClick={() => navigate(`/lawfirm/${lawFirmId}/contacts/${contact.id}`)}
                              className="inline-flex items-center rounded-full bg-surface-alt px-2 py-0.5 text-[10px] font-medium text-on-surface-secondary border border-outline-subtle hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                            >
                              {contact.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {canManageCourts && (
                      <div className="flex gap-2">
                        <Button
                          type="secondary"
                          size="small"
                          onClick={() => startEdit(court)}
                          disabled={deletingId === court.id}
                        >
                          Edit
                        </Button>
                        <Button
                          type="secondary"
                          size="small"
                          onClick={() => {
                            setDeleteError(null);
                            setCourtToDelete(court);
                          }}
                          disabled={deletingId === court.id}
                          loading={deletingId === court.id}
                        >
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
            {listPager.total > listPager.rowsPerPage && (
              <li className="px-4 py-3">
                <AutoPager pager={listPager} />
              </li>
            )}
          </ul>
        )}
      </div>}

      <ConfirmModal
        isOpen={!!courtToDelete}
        onClose={() => setCourtToDelete(null)}
        onConfirm={confirmDelete}
        title="Delete court"
        message={`Are you sure you want to delete the court "${courtToDelete?.name ?? ''}"? This cannot be undone.`}
        confirmText="Delete"
        confirmType="danger"
        loading={deletingId === courtToDelete?.id}
        error={deleteError}
      />

      <CourtCatalogPickerModal
        open={showCatalog}
        lawFirmId={lawFirmId}
        onClose={() => setShowCatalog(false)}
        onAdopted={load}
      />
    </div>
  );
}
