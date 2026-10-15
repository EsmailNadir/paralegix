'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Edit3,
  FileText,
  LayoutTemplate,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import ConfirmModal from '@/components/ui/ConfirmModal';
import ErrorNotification from '@/components/ErrorNotification';
import ListEmptyState from '@/components/ui/ListEmptyState';
import ListSkeleton from '@/components/ui/ListSkeleton';
import ListToolbar from '@/components/ui/ListToolbar';
import RowActionMenu from '@/components/ui/RowActionMenu';
import { AutoPager } from '@/components/ui/ListPager';
import { INPUT_CLS } from '@/components/ui/inputClasses';
import Modal from '@/components/ui/Modal';
import usePagedRows from '@/hooks/usePagedRows';
import { useSigningTemplates } from '@/hooks/signatureHooks/useSigningTemplates';
import { useNavigation } from '@/contexts/NavigationContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import signaturesService from '@/services/signatures.service';
import type { SigningTemplate } from '@/types/signature';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import FieldLabel from '@/components/ui/FieldLabel';
import SearchInput from "@/components/ui/SearchInput";

const TEMPLATES_PER_PAGE = 9;

const ROUTING_LABELS: Record<string, string> = {
  sequential: 'Signs in order',
  parallel: 'Signs in any order',
};

interface SigningTemplateGridProps {
  lawFirmId: string;
  /** Seeds the search box, so a link can arrive already filtered. */
  initialSearch?: string;
}

/**
 * The firm's saved signer layouts, as a searchable grid of cards.
 *
 * Templates are a starting point for new work, not a record of past work, so they
 * get a view of their own rather than a strip under the signing history - where
 * they sat below however many sessions the firm had, and were effectively
 * unreachable for a firm with a real history. Opening a card starts a signing
 * session from that template's document and field layout.
 */
export default function SigningTemplateGrid({ lawFirmId, initialSearch = '' }: SigningTemplateGridProps) {
  const fieldIds = useId();
  const { navigate } = useNavigation();
  const { hasPermission } = usePermissions();
  const canManageTemplates = hasPermission('signatures.send');
  // Cached and shared with the signing editor, so arriving here doesn't re-fetch.
  const { templates: allTemplates, loading, error: loadError, refetch } = useSigningTemplates(lawFirmId);

  // A template whose source document was auto-cleaned from transient storage
  // has nothing to open and can never be reused, so it is excluded rather than
  // shown as a dead end.
  const templates = useMemo(
    () => allTemplates.filter((template) => !!template.sourceObjectPath && !!template.sourceFileName),
    [allTemplates],
  );

  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState(initialSearch);
  const [editing, setEditing] = useState<SigningTemplate | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const closeEdit = () => setEditOpen(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs the user-editable search term when the controlling initialSearch prop changes
    setSearchTerm(initialSearch);
  }, [initialSearch]);

  const openEdit = (template: SigningTemplate) => {
    setEditError(null);
    setEditing(template);
    setName(template.name);
    setDescription(template.description || '');
    setEditOpen(true);
  };

  const handleSave = async () => {
    if (!editing) return;
    setSaving(true);
    setEditError(null);
    try {
      await signaturesService.updateSigningTemplate(lawFirmId, editing.templateId, {
        name: name.trim(),
        description: description.trim(),
      });
      setEditOpen(false);
      setName('');
      setDescription('');
      await refetch();
    } catch (err) {
      setEditError(getErrorMessage(err, 'Failed to update template'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (templateId: string) => {
    setDeletingId(templateId);
    setError(null);
    try {
      await signaturesService.deleteSigningTemplate(lawFirmId, templateId);
      await refetch();
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to delete template'));
    } finally {
      setDeletingId(null);
    }
  };

  // Opens the signing editor on the template's own document with its fields
  // already placed.
  const handleOpenTemplate = (template: SigningTemplate) => {
    if (!template.sourceObjectPath || !template.sourceFileName) return;
    setError(null);
    const params = new URLSearchParams({
      objectPath: template.sourceObjectPath,
      fileName: template.sourceFileName,
      mode: 'designate',
      lawFirmId,
      templateId: template.templateId,
    });
    navigate(`/signature?${params.toString()}`);
  };

  const normalizedSearch = searchTerm.trim().toLowerCase();

  const filteredTemplates = useMemo(() => {
    if (!normalizedSearch) return templates;
    return templates.filter((template) => [
      template.name,
      template.description,
      template.sourceFileName,
      ...(template.signerRoles || []).map((role) => role.roleLabel),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(normalizedSearch));
  }, [normalizedSearch, templates]);

  const pager = usePagedRows(filteredTemplates, TEMPLATES_PER_PAGE, normalizedSearch);

  // Only offered while the banner is showing the LOAD failure: an action failure
  // (a template that could not be saved) is not fixed by fetching the list again.
  const [retryingLoad, setRetryingLoad] = useState(false);
  const retryLoad = useCallback(async () => {
    setRetryingLoad(true);
    try {
      await refetch();
    } finally {
      setRetryingLoad(false);
    }
  }, [refetch]);
  const retryProps = loadError && !error
    ? { onRetry: retryLoad, retrying: retryingLoad }
    : {};

  if (loading) {
    return <ListSkeleton rows={4} label="Loading signing templates" />;
  }

  if (templates.length === 0) {
    return (
      <>
        <ErrorNotification error={error || loadError} onClose={() => setError(null)} className="mb-4" {...retryProps} />
        <ListEmptyState
          icon={<LayoutTemplate size={40} />}
          title="No signing templates yet"
          message="While placing signature fields on a document, save the layout as a template. It'll show up here, ready to reuse on the next document that needs the same signers."
        />
      </>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-on-surface-secondary">
        Reusable signer and field layouts saved from previous documents. Select a template to start a signing session with its signers and signature fields pre-configured.
      </p>

      <ListToolbar>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <SearchInput
            size="sm"
            className="min-w-0 flex-1 sm:min-w-64"
            placeholder="Search by name, signer role, or document..."
            aria-label="Search signing templates"
            value={searchTerm}
            onChange={(next) => setSearchTerm(next)}
            onClear={() => setSearchTerm('')}
          />
          <p className="shrink-0 text-xs text-on-surface-muted">
            {normalizedSearch
              ? `${filteredTemplates.length} of ${templates.length} template${templates.length !== 1 ? 's' : ''}`
              : `${templates.length} template${templates.length !== 1 ? 's' : ''}`}
          </p>
        </div>
      </ListToolbar>

      <ErrorNotification error={error || loadError} onClose={() => setError(null)} {...retryProps} />

      {filteredTemplates.length === 0 ? (
        <ListEmptyState
          compact
          icon={<Search size={36} />}
          title="No templates match that search"
          message="Try a different name, signer role, or document title."
          action={(
            <Button
              type="secondary"
              onClick={() => setSearchTerm('')}
            >
              Clear search
            </Button>
          )}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {pager.pagedRows.map((template) => {
              const routingLabel = ROUTING_LABELS[template.routingMode || 'sequential']
                ?? ROUTING_LABELS.sequential;

              return (
                <div
                  key={template.templateId}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleOpenTemplate(template)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleOpenTemplate(template);
                    }
                  }}
                  className={`group flex cursor-pointer flex-col rounded-xl border border-outline bg-surface p-4 transition-colors hover:bg-surface-hover ${
                    deletingId === template.templateId ? 'pointer-events-none opacity-50' : ''
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-emphasis">
                      <LayoutTemplate size={17} strokeWidth={2} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-on-surface">{template.name}</p>
                      <p className="mt-0.5 text-xs text-on-surface-muted">
                        {template.signerRoles.length} signer{template.signerRoles.length !== 1 ? 's' : ''}
                        {' · '}
                        {template.fields.length} field{template.fields.length !== 1 ? 's' : ''}
                        {template.signerRoles.length > 1 ? ` · ${routingLabel}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0">
                      {canManageTemplates && (
                        <RowActionMenu
                          ariaLabel={`Actions for ${template.name}`}
                          actions={[
                            { label: 'Edit details', icon: <Edit3 size={15} />, onClick: () => openEdit(template) },
                            {
                              label: 'Delete',
                              icon: <Trash2 size={15} />,
                              onClick: () => setDeleteTarget(template.templateId),
                              danger: true,
                            },
                          ]}
                        />
                      )}
                    </div>
                  </div>

                  {template.description && (
                    <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-on-surface-secondary">
                      {template.description}
                    </p>
                  )}

                  <div className="mt-auto flex items-center gap-2 border-t border-outline-subtle pt-3 text-xs">
                    <FileText size={13} className="shrink-0 text-on-surface-muted" />
                    <span className="min-w-0 flex-1 truncate text-on-surface-muted">
                      {template.sourceFileName}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 font-medium text-accent-emphasis">
                      Use
                      <ArrowUpRight size={13} />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          <AutoPager pager={pager} />
        </>
      )}

      <ConfirmModal
        isOpen={!!deleteTarget}
        title="Delete Template"
        message="Are you sure you want to delete this signing template? This cannot be undone."
        confirmText="Delete"
        confirmType="danger"
        onConfirm={() => {
          if (deleteTarget) handleDelete(deleteTarget);
          setDeleteTarget(null);
        }}
        onClose={() => setDeleteTarget(null)}
      />

      {editing && (
        <Modal
          isOpen={editOpen}
          onClose={closeEdit}
          dismissible={!saving}
          title="Edit Template"
          size="lg"
          closeIcon={<X size={18} strokeWidth={2} />}
          footer={
            <>
              <Button type="secondary" onClick={closeEdit} disabled={saving}>Cancel</Button>
              <Button type="primary" onClick={handleSave} loading={saving} disabled={saving || !name.trim()}>
                Save Changes
              </Button>
            </>
          }
        >
          <ErrorNotification error={editError} onClose={() => setEditError(null)} compact />

          <div>
            <FieldLabel htmlFor={`${fieldIds}-name`}>Template Name *</FieldLabel>
            <input
              id={`${fieldIds}-name`}
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={`${INPUT_CLS} w-full`}
            />
          </div>
          <div>
            <FieldLabel htmlFor={`${fieldIds}-description`}>Description</FieldLabel>
            <textarea
              id={`${fieldIds}-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className={`${INPUT_CLS} w-full resize-none`}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
