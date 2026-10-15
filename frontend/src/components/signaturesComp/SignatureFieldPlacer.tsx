'use client';

import { useId, useState, useReducer, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  X,
  Trash2,
  Send,
  Check,
  ArrowLeft,
  FolderOpen,
  Lock,
  Plus,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  BookmarkPlus,
  Building2,
  Calendar,
  CheckSquare,
  PenLine,
  PenSquare,
  Type,
  Copy,
  Info,
} from 'lucide-react';
import PDFPageViewer from './PDFPageViewer';
import SignatureVisual from './SignatureVisual';
import DestinationPickerModal from './DestinationPickerModal';
import Dropdown from '@/components/ui/Dropdown';
import EntityPicker from '@/components/ui/EntityPicker';
import { useEntityLookup, type LookupItem } from '@/hooks/useEntityLookup';
import { useSigningRecipients } from '@/hooks/signatureHooks/useSigningRecipients';
import Checkbox from '@/components/ui/Checkbox';
import ConfirmModal from '@/components/ui/ConfirmModal';
import FieldError from '@/components/ui/FieldError';
import ScrollArea from '@/components/ui/ScrollArea';
import { fieldsOutsideDocument } from './templateFields';
import { pageFromPoint } from './pdfPointerPage';
import ZoomControls from '@/components/ui/ZoomControls';
import { startPointerDrag } from '@/lib/utils/pointerDrag';
import { useDocumentZoom } from '@/hooks/useDocumentZoom';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import Modal from '@/components/ui/Modal';
import { DEFAULT_FIELD_SIZE, DEFAULT_SIGNATURE_STYLE, resolveSignatureStyle } from '@/types/signature';
import type {
  FieldType,
  RoutingMode,
  SignatureField,
  SignatureStyle,
  SigningRecipient,
  ToolMode,
  SigningParticipant,
  SignerDeliveryMethod,
} from '@/types/signature';
import Tooltip from "@/components/ui/Tooltip";
import signaturesService from '@/services/signatures.service';
import lawFirmService from '@/services/lawfirm.service';
import { markSigningTemplatesDirty } from '@/hooks/signatureHooks/useSigningTemplates';
import Spinner from '@/components/ui/Spinner';
import { SEARCH_DEBOUNCE_MS, lookupOverflowNote } from '@/lib/constants/search';
import { getErrorMessage } from '@/lib/utils/apiErrors';
import FieldLabel from '@/components/ui/FieldLabel';

interface SignatureFieldPlacerProps {
  file: { url: string; name: string; bytes?: Uint8Array };
  lawFirmId: string;
  objectPath: string;
  templateId?: string;
  onBack: () => void;
  initialDestinationPath?: string;
  initialDestinationLabel?: string;
}

/**
 * A `full=true` clients-lookup row, narrowed to the fields the signer payload
 * reads. The full row is the enriched client record, so `name` and `email` are
 * the client's own values rather than the display-only `label`/`sublabel`.
 */
type PortalClientLookupItem = LookupItem & {
  name?: string | null;
  email?: string | null;
};

/**
 * A `full=true` contacts-lookup row. Picking one fills the name and email
 * fields rather than becoming the signer's identity: a directory contact has no
 * portal account, so they are still an ordinary email recipient. The typed
 * values stay editable afterwards.
 */
type ContactLookupItem = LookupItem & {
  name?: string | null;
  email?: string | null;
};

/**
 * An account-backed recipient chosen for a signer, from the dedicated
 * `/signature-links/recipients` endpoint. `userId` is the Firebase uid
 * actually asked to sign and doubles as the picker's unique key, because
 * `clientId` alone is NOT unique here: a person linked to several companies
 * yields one row per company, all sharing one `clientId`. `companyLinkId`/
 * `companyName` are set only when this row represents a company-linked
 * person rather than a standalone one.
 */
interface SigningRecipientSelection {
  userId: string;
  name: string;
  email: string;
  clientId: string;
  clientName: string;
  clientType: 'person' | 'company';
  companyLinkId: string | null;
  companyName: string | null;
}

function toRecipientSelection(item: SigningRecipient): SigningRecipientSelection {
  return {
    userId: item.userId,
    name: (item.name || '').trim() || 'Unnamed Client',
    email: (item.email || '').trim(),
    clientId: item.clientId,
    clientName: item.clientName || '',
    clientType: item.clientType,
    companyLinkId: item.companyLinkId,
    companyName: item.companyName,
  };
}

interface MemberOption {
  userId: string;
  name: string;
  email: string;
}

interface SignerAutofillOption {
  value: string;
  label: string;
  name: string;
  email: string;
}

type ParalegixRecipientSelection =
  | { kind: 'client'; client: SigningRecipientSelection }
  | { kind: 'member'; member: MemberOption };

interface ParalegixRecipientOption {
  value: string;
  label: string;
  /** Set for a company roster contact, so the picker can mark it with Building2. */
  isCompanyContact?: boolean;
  selection: ParalegixRecipientSelection;
}

/**
 * Searches the three firm-owned sources that commonly identify a signer. This
 * is an autofill aid only: choosing a row copies its name and email into the
 * ordinary signer fields and does not change the selected delivery method.
 */
function SignerAutofillPicker({
  lawFirmId,
  members,
  onSelect,
}: {
  lawFirmId: string;
  members: MemberOption[];
  onSelect: (identity: { name: string; email: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const contactsLookup = useEntityLookup<ContactLookupItem>('contacts', lawFirmId, {
    search: debouncedSearch,
    enabled: open,
    full: true,
  });
  const clientsLookup = useEntityLookup<PortalClientLookupItem>('clients', lawFirmId, {
    search: debouncedSearch,
    enabled: open,
    excludeArchived: true,
    full: true,
  });

  const options = useMemo<SignerAutofillOption[]>(() => {
    const q = debouncedSearch.trim().toLowerCase();
    // Each source settles independently. A previous-term placeholder from one
    // lookup must not hide current results from another, or a slow clients
    // request can make valid directory contacts look like they do not exist.
    const currentClients = clientsLookup.isPlaceholder ? [] : clientsLookup.items;
    const currentContacts = contactsLookup.isPlaceholder ? [] : contactsLookup.items;
    const teamMatches = members.filter((member) => {
      if (!q) return true;
      return member.name.toLowerCase().includes(q) || member.email.toLowerCase().includes(q);
    });

    const describe = (name: string, email: string, source: string) =>
      `${name}${email ? ` (${email})` : ''} · ${source}`;

    return [
      ...currentContacts.map((item) => {
        const name = (item.name || item.label || '').trim() || 'Unnamed Contact';
        const email = (item.email || '').trim();
        return {
          value: `contact:${item.id}`,
          label: describe(name, email, 'Contact'),
          name,
          email,
        };
      }),
      ...currentClients.map((item) => {
        const name = (item.name || item.label || '').trim() || 'Unnamed Client';
        const email = (item.email || '').trim();
        return {
          value: `client:${item.id}`,
          label: describe(name, email, 'Client'),
          name,
          email,
        };
      }),
      ...teamMatches.map((member) => ({
        value: `member:${member.userId}`,
        label: describe(member.name, member.email, 'Team'),
        name: member.name,
        email: member.email,
      })),
    ];
  }, [
    clientsLookup.isPlaceholder,
    clientsLookup.items,
    contactsLookup.isPlaceholder,
    contactsLookup.items,
    debouncedSearch,
    members,
  ]);

  const searching =
    open &&
    (searchInput.trim() !== debouncedSearch.trim() ||
      (options.length === 0 && (contactsLookup.loading || clientsLookup.loading)));

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setSearchInput('');
      setDebouncedSearch('');
    }
  };

  const footerNote = lookupOverflowNote(
    contactsLookup.hasMore || clientsLookup.hasMore,
    searchInput,
  );

  return (
    <Dropdown
      portal
      value=""
      onChange={(value) => {
        const selected = options.find((option) => option.value === value);
        if (selected) onSelect({ name: selected.name, email: selected.email });
      }}
      options={options.map(({ value, label }) => ({ value, label }))}
      placeholder="Search contacts, clients, and team…"
      buttonClassName="border-input-border bg-surface-alt"
      searchValue={searchInput}
      onSearchChange={setSearchInput}
      onOpenChange={handleOpenChange}
      loading={searching}
      clearOptionsWhileLoading
      searchPlaceholder="Search contacts, clients, and team…"
      footerNote={footerNote}
    />
  );
}

/**
 * Selects an account-backed signer for delivery inside Paralegix: a person
 * client, a company roster contact, or a team member. Client/contact options
 * come from the dedicated `/signature-links/recipients` endpoint, which - unlike
 * the generic `clients` lookup's `portalOnly` filter - can actually see a
 * company's roster contacts (their portal identity lives on `contact_clients`,
 * not `clients.user_id`).
 *
 * `orgClientId` narrows the list to one company's roster. The endpoint resolves
 * it against `company_client_id`, so a company's own `clients.id` is the value
 * to send even though the company itself is never a row in the result.
 */
function ParalegixRecipientPicker({
  lawFirmId,
  members,
  orgClientId,
  selectedClient,
  selectedMemberId,
  onSelect,
}: {
  lawFirmId: string;
  members: MemberOption[];
  orgClientId?: string;
  selectedClient?: SigningRecipientSelection | null;
  selectedMemberId?: string;
  onSelect: (selection: ParalegixRecipientSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const recipientsLookup = useSigningRecipients(lawFirmId, {
    search: debouncedSearch,
    clientId: orgClientId || undefined,
    enabled: open,
  });

  const options = useMemo<ParalegixRecipientOption[]>(() => {
    const q = debouncedSearch.trim().toLowerCase();
    const clientOptions = recipientsLookup.items.map((item) => {
      const client = toRecipientSelection(item);
      const isCompanyContact = Boolean(client.companyName);
      // A company-linked person's own name doesn't say who they work for, so a
      // firm member picking between several of them needs the company name in
      // the row, e.g. "Jane Doe (jane@acme.com) · Acme Manufacturing LLC".
      const suffix = isCompanyContact ? client.companyName || 'Company' : 'Client portal';
      return {
        value: `client:${client.userId}`,
        label: `${client.name}${client.email ? ` (${client.email})` : ''} · ${suffix}`,
        isCompanyContact,
        selection: { kind: 'client' as const, client },
      };
    });

    if (selectedClient && !clientOptions.some((option) => option.value === `client:${selectedClient.userId}`)) {
      const isCompanyContact = Boolean(selectedClient.companyName);
      const suffix = isCompanyContact ? selectedClient.companyName || 'Company' : 'Client portal';
      clientOptions.unshift({
        value: `client:${selectedClient.userId}`,
        label: `${selectedClient.name}${selectedClient.email ? ` (${selectedClient.email})` : ''} · ${suffix}`,
        isCompanyContact,
        selection: { kind: 'client', client: selectedClient },
      });
    }

    // An organization filter asks for that organization's people, so team
    // members leave the list while one is set. The member already chosen stays,
    // or the trigger would read as though the selection had been lost.
    const memberOptions = members
      .filter((member) => !orgClientId || member.userId === selectedMemberId)
      .filter((member) => !q || member.name.toLowerCase().includes(q) || member.email.toLowerCase().includes(q))
      .map((member) => ({
        value: `member:${member.userId}`,
        label: `${member.name}${member.email ? ` (${member.email})` : ''} · Team dashboard`,
        selection: { kind: 'member' as const, member },
      }));

    return [...clientOptions, ...memberOptions];
  }, [recipientsLookup.items, debouncedSearch, members, orgClientId, selectedClient, selectedMemberId]);

  const value = selectedClient
    ? `client:${selectedClient.userId}`
    : selectedMemberId
      ? `member:${selectedMemberId}`
      : '';
  const searching =
    open &&
    (searchInput.trim() !== debouncedSearch.trim()
      || recipientsLookup.isPlaceholder
      || (recipientsLookup.loading && recipientsLookup.items.length === 0));

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setSearchInput('');
      setDebouncedSearch('');
    }
  };

  const searchLabel = orgClientId
    ? 'Search organization contacts…'
    : 'Search portal clients and team…';

  return (
    <Dropdown
      portal
      value={value}
      onChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option) onSelect(option.selection);
      }}
      options={options.map(({ value: optionValue, label, isCompanyContact }) => ({
        value: optionValue,
        label,
        icon: isCompanyContact ? Building2 : undefined,
      }))}
      placeholder={searchLabel}
      searchValue={searchInput}
      onSearchChange={setSearchInput}
      onOpenChange={handleOpenChange}
      loading={searching}
      clearOptionsWhileLoading
      searchPlaceholder={searchLabel}
      footerNote={lookupOverflowNote(recipientsLookup.hasMore, searchInput)}
    />
  );
}

interface DraftSigner extends SigningParticipant {
  /**
   * The chosen recipient's Firebase uid, i.e. the value the Paralegix
   * recipient picker is keyed on. A `clients.id` would NOT be unique here (a
   * company's roster contacts all share one), so this is `userId` itself -
   * which is also the identity the signing request is addressed to.
   */
  selectedRecipientUserId?: string;
  /**
   * The lookup row behind `selectedRecipientUserId`, captured when the user
   * picked it. `buildSignerPayload` sends its `userId` as `clientUserId`, which
   * is what decides who is actually asked to sign, so the two fields are
   * always written together and a mismatch between them blocks the send
   * rather than guessing.
   */
  selectedClient?: SigningRecipientSelection | null;
  selectedMemberId?: string;
  /**
   * The company `clients.id` the recipient picker is narrowed to, or undefined
   * for the whole firm. A browse aid only: it never reaches the send payload,
   * and it never changes or clears a recipient already picked.
   */
  recipientOrgClientId?: string;
  /**
   * True until the user types into the "Label for this signer" field
   * themselves. That field is hidden for a single signer (see
   * `SignerIdentityCard`), so picking a team member as the sole recipient
   * would otherwise send with whatever generic guess this signer started
   * with - "Client" for the first signer - with no way to have noticed or
   * corrected it. While this stays true, picking a Paralegix recipient keeps
   * the label matched to what was actually picked.
   */
  roleLabelAuto?: boolean;
}

type FieldAction =
  | { type: 'ADD'; field: SignatureField }
  | { type: 'REPLACE_ALL'; fields: SignatureField[]; selectedId?: string | null }
  | { type: 'MOVE'; id: string; xPercent: number; yPercent: number }
  | { type: 'MOVE_TO_PAGE'; id: string; page: number; xPercent: number; yPercent: number }
  | { type: 'RESIZE'; id: string; widthPercent: number; heightPercent: number }
  | { type: 'STYLE'; id: string; style: SignatureStyle }
  | { type: 'ASSIGN_SIGNER'; id: string; signerId: string }
  | { type: 'UPDATE'; id: string; changes: Partial<SignatureField> }
  | { type: 'DELETE'; id: string }
  | { type: 'SELECT'; id: string | null };

interface FieldState {
  fields: SignatureField[];
  selectedId: string | null;
}

const SIGNER_COLORS = [
  {
    border: 'border-accent-solid',
    bg: 'bg-accent-soft',
    solid: 'bg-accent-solid',
    badge: 'bg-accent-soft text-accent-emphasis',
    text: 'text-accent-emphasis dark:text-accent-emphasis',
  },
  {
    border: 'border-emerald-500',
    bg: 'bg-emerald-500/20',
    solid: 'bg-emerald-500',
    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    border: 'border-amber-500',
    bg: 'bg-amber-500/20',
    solid: 'bg-amber-500',
    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    text: 'text-amber-600 dark:text-amber-400',
  },
  {
    border: 'border-purple-500',
    bg: 'bg-purple-500/20',
    solid: 'bg-purple-500',
    badge: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
    text: 'text-purple-600 dark:text-purple-400',
  },
  {
    border: 'border-rose-500',
    bg: 'bg-rose-500/20',
    solid: 'bg-rose-500',
    badge: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
    text: 'text-rose-600 dark:text-rose-400',
  },
];

const FIELD_TYPE_OPTIONS: Array<{
  type: FieldType;
  label: string;
  icon: typeof PenLine;
}> = [
  { type: 'signature', label: 'Signature', icon: PenLine },
  { type: 'initials', label: 'Initials', icon: PenSquare },
  { type: 'text', label: 'Text', icon: Type },
  { type: 'date', label: 'Date', icon: Calendar },
  { type: 'checkbox', label: 'Checkbox', icon: CheckSquare },
];

let fieldCounter = 0;
let signerCounter = 0;
const TEMPLATE_ROLE_REF_PREFIX = 'role:';

function genFieldId() {
  return `field_${Date.now()}_${++fieldCounter}`;
}

function genSignerId() {
  return `participant_${Date.now()}_${++signerCounter}`;
}

function fieldReducer(state: FieldState, action: FieldAction): FieldState {
  switch (action.type) {
    case 'ADD':
      // A newly placed field is left unselected, and placing one clears any
      // existing selection, so the canvas is never selected right after a drop.
      return { ...state, fields: [...state.fields, action.field], selectedId: null };
    case 'REPLACE_ALL':
      return { fields: action.fields, selectedId: action.selectedId ?? null };
    case 'MOVE':
      return {
        ...state,
        fields: state.fields.map((field) =>
          field.id === action.id ? { ...field, xPercent: action.xPercent, yPercent: action.yPercent } : field
        ),
      };
    case 'MOVE_TO_PAGE':
      return {
        ...state,
        fields: state.fields.map((field) =>
          field.id === action.id
            ? { ...field, page: action.page, xPercent: action.xPercent, yPercent: action.yPercent }
            : field
        ),
      };
    case 'RESIZE':
      return {
        ...state,
        fields: state.fields.map((field) =>
          field.id === action.id ? { ...field, widthPercent: action.widthPercent, heightPercent: action.heightPercent } : field
        ),
      };
    case 'STYLE':
      return {
        ...state,
        fields: state.fields.map((field) =>
          field.id === action.id ? { ...field, style: action.style } : field
        ),
      };
    case 'ASSIGN_SIGNER':
      return {
        ...state,
        fields: state.fields.map((field) =>
          field.id === action.id ? { ...field, signerId: action.signerId } : field
        ),
      };
    case 'UPDATE':
      return {
        ...state,
        fields: state.fields.map((field) =>
          field.id === action.id ? { ...field, ...action.changes } : field
        ),
      };
    case 'DELETE':
      return {
        ...state,
        fields: state.fields.filter((field) => field.id !== action.id),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
      };
    case 'SELECT':
      return { ...state, selectedId: action.id };
    default:
      return state;
  }
}

function createDraftSigner(index: number, overrides: Partial<DraftSigner> = {}): DraftSigner {
  return {
    participantId: overrides.participantId || genSignerId(),
    roleLabel: overrides.roleLabel || `Signer ${index + 1}`,
    roleLabelAuto: overrides.roleLabelAuto ?? true,
    order: overrides.order || index + 1,
    deliveryMethod: overrides.deliveryMethod || 'email',
    name: overrides.name || '',
    email: overrides.email || '',
    memberUserId: overrides.memberUserId,
    clientUserId: overrides.clientUserId,
    accessCode: overrides.accessCode || '',
    selectedRecipientUserId: overrides.selectedRecipientUserId,
    selectedClient: overrides.selectedClient,
    selectedMemberId: overrides.selectedMemberId,
  };
}

type PortalSignerResolution =
  | { ok: true; client: SigningRecipientSelection; clientUserId: string }
  // `incomplete` marks a field the user simply has not filled in yet, as opposed
  // to a choice that cannot work. Only the latter is worth telling them about
  // before they try to send.
  | { ok: false; error: string; incomplete?: boolean };

/**
 * Resolves the identity a portal signer will actually be addressed as, or an
 * explanation of why it cannot be resolved.
 *
 * There is deliberately no fallback to the `clients` row id: the two are
 * different values, so substituting one would send the document to whoever the
 * row id happens to collide with, or to nobody, with no visible sign in the UI
 * that the wrong party was asked to sign. An unresolvable selection is an error.
 *
 * Shared by the pre-send validation and the payload builder so the check that
 * blocks the UI and the check that guards the request cannot drift apart.
 */
function resolvePortalSigner(signer: DraftSigner, roleLabel: string): PortalSignerResolution {
  const selected = signer.selectedClient;
  if (!signer.selectedRecipientUserId || !selected || selected.userId !== signer.selectedRecipientUserId) {
    return { ok: false, error: `Select a portal client for ${roleLabel}.`, incomplete: true };
  }

  const clientUserId = selected.userId?.trim();
  if (!clientUserId) {
    return {
      ok: false,
      error: `${selected.name} has no client portal account, so this document cannot be sent to them through the portal. Pick a different client or change how this signer receives it.`,
    };
  }

  return { ok: true, client: selected, clientUserId };
}

function normalizeSignerOrders(signers: DraftSigner[]) {
  return signers.map((signer, index) => ({ ...signer, order: index + 1 }));
}

/** What stops a signer from being sent to, or null when they are ready. */
type SignerIdentityIssue = {
  /** Full sentence, for the one place that explains why sending is blocked. */
  message: string;
  /** Two or three words, for the signer's own row. */
  rowLabel: string;
  /**
   * True when the field is simply not filled in yet (the state every new signer
   * row starts in) rather than a choice that cannot work.
   */
  incomplete: boolean;
};

function signerIdentityIssue(signer: DraftSigner, index: number): SignerIdentityIssue | null {
  const roleLabel = getSignerDisplayLabel(signer, index);

  if (signer.deliveryMethod === 'portal') {
    const resolved = resolvePortalSigner(signer, roleLabel);
    if (!resolved.ok) {
      return {
        message: resolved.error,
        rowLabel: resolved.incomplete ? 'Pick a client' : 'No portal account',
        incomplete: Boolean(resolved.incomplete),
      };
    }
  }

  if (signer.deliveryMethod === 'internal_dashboard' && !signer.selectedMemberId) {
    return { message: `Select a team member for ${roleLabel}.`, rowLabel: 'Pick a member', incomplete: true };
  }

  if (signer.deliveryMethod === 'copy_link' && !signer.name?.trim()) {
    return { message: `Enter a signer name for ${roleLabel}.`, rowLabel: 'Add a name', incomplete: true };
  }

  if (signer.deliveryMethod === 'email' && !signer.email?.trim()) {
    return { message: `Enter an email address for ${roleLabel}.`, rowLabel: 'Add an email', incomplete: true };
  }

  const accessCode = signer.accessCode?.trim();
  if (accessCode && accessCode.length < 6) {
    return {
      message: `Access code for ${roleLabel} must be at least 6 characters.`,
      rowLabel: 'Fix access code',
      incomplete: false,
    };
  }

  return null;
}

function getSignerDisplayLabel(signer: DraftSigner, index: number) {
  return signer.roleLabel.trim() || `Signer ${index + 1}`;
}

function signerPillLabel(signer: DraftSigner, index: number) {
  const identity = signer.name?.trim() || signer.email?.trim();
  const role = getSignerDisplayLabel(signer, index);
  return identity ? `${role}: ${identity}` : role;
}

function createTemplateRoleRef(order: number) {
  return `${TEMPLATE_ROLE_REF_PREFIX}${order}`;
}

function resolveTemplateSignerId(
  savedSignerId: string | undefined,
  signerRoles: Array<{ roleLabel: string; order: number }>,
  roleIdByOrder: Map<number, string>,
) {
  if (!savedSignerId) {
    return roleIdByOrder.get(1);
  }

  if (savedSignerId.startsWith(TEMPLATE_ROLE_REF_PREFIX)) {
    const order = Number(savedSignerId.slice(TEMPLATE_ROLE_REF_PREFIX.length));
    return roleIdByOrder.get(order);
  }

  const numericOrder = Number(savedSignerId);
  if (!Number.isNaN(numericOrder)) {
    return roleIdByOrder.get(numericOrder);
  }

  const matchingRole = signerRoles.find((role) => role.roleLabel === savedSignerId);
  return matchingRole ? roleIdByOrder.get(matchingRole.order) : undefined;
}

function getDefaultFieldLabel(fieldType: FieldType) {
  switch (fieldType) {
    case 'initials':
      return 'Initials';
    case 'date':
      return 'Date';
    case 'text':
      return 'Text';
    case 'checkbox':
      return 'Checkbox';
    default:
      return 'Signature';
  }
}

function getDefaultFieldSize(fieldType: FieldType) {
  switch (fieldType) {
    case 'checkbox':
      return { widthPercent: 6, heightPercent: 6 };
    case 'date':
      return { widthPercent: 18, heightPercent: DEFAULT_FIELD_SIZE.heightPercent };
    case 'text':
      return { widthPercent: 24, heightPercent: DEFAULT_FIELD_SIZE.heightPercent };
    default:
      return DEFAULT_FIELD_SIZE;
  }
}

function getMaxFieldSize(fieldType: FieldType) {
  switch (fieldType) {
    case 'signature':
    case 'initials':
      return { maxWidth: 30, maxHeight: 12 };
    case 'checkbox':
      return { maxWidth: 8, maxHeight: 8 };
    default:
      return { maxWidth: 50, maxHeight: 20 };
  }
}

function clampPercent(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampFieldPlacement(
  xPercent: number,
  yPercent: number,
  widthPercent: number,
  heightPercent: number,
) {
  const safeWidth = clampPercent(widthPercent, 1, 100);
  const safeHeight = clampPercent(heightPercent, 1, 100);

  return {
    xPercent: clampPercent(xPercent, 0, Math.max(0, 100 - safeWidth)),
    yPercent: clampPercent(yPercent, 0, Math.max(0, 100 - safeHeight)),
    widthPercent: safeWidth,
    heightPercent: safeHeight,
  };
}

function colorForSigner(index: number) {
  return SIGNER_COLORS[index % SIGNER_COLORS.length];
}

function FieldOverlay({
  field,
  colorIndex,
  isSelected,
  isSignerActive,
  pageWidth,
  pageHeight,
  signers,
  onSelect,
  onMove,
  onMoveToPage,
  onResize,
  onSignerChange,
  onDelete,
}: {
  field: SignatureField;
  colorIndex: number;
  isSelected: boolean;
  isSignerActive: boolean;
  pageWidth: number;
  pageHeight: number;
  signers: DraftSigner[];
  onSelect: () => void;
  onMove: (xPercent: number, yPercent: number) => void;
  /** The drag was released over a different page; land the field there. */
  onMoveToPage: (page: number, xPercent: number, yPercent: number) => void;
  onResize: (widthPercent: number, heightPercent: number) => void;
  onSignerChange: (signerId: string) => void;
  onDelete: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const color = colorForSigner(colorIndex);

  const left = (field.xPercent / 100) * pageWidth;
  const top = (field.yPercent / 100) * pageHeight;
  const width = (field.widthPercent / 100) * pageWidth;
  const height = (field.heightPercent / 100) * pageHeight;
  const fieldStyle = resolveSignatureStyle(field.style);
  const fieldType = field.fieldType || 'signature';

  const handleDragStart = useCallback(
    (e: React.PointerEvent) => {
      if (!e.isPrimary) return;
      e.preventDefault();
      e.stopPropagation();
      onSelect();

      const rect = containerRef.current!.getBoundingClientRect();
      const grabX = e.clientX - rect.left;
      const grabY = e.clientY - rect.top;
      // The page the field currently sits on, tracked inside the closure. The
      // drag deliberately reads NOTHING through `containerRef` after this point:
      // crossing onto another page dispatches a page change, which remounts this
      // overlay under the new page - and `startPointerDrag`'s listeners live on
      // `window`, so the closure keeps driving the gesture through the remount
      // as long as it measures pages by geometry instead of through its own ref.
      let dragPage = field.page;

      startPointerDrag(e, {
        onMove: (move) => {
          // Whichever page the pointer is over is where the field goes. In the
          // gap between pages (or off the stack) it stays with its current page,
          // clamped to that page's edge, until the pointer reaches the next one.
          const over = pageFromPoint(move.clientX, move.clientY);
          const pageEl = over?.element
            ?? document.querySelector<HTMLElement>(`[data-pdf-page="${dragPage}"]`);
          if (!pageEl) return;
          const pageRect = pageEl.getBoundingClientRect();
          if (pageRect.width <= 0 || pageRect.height <= 0) return;

          const newLeft = move.clientX - pageRect.left - grabX;
          const newTop = move.clientY - pageRect.top - grabY;
          const xPercent = Math.max(0, Math.min(100 - field.widthPercent, (newLeft / pageRect.width) * 100));
          const yPercent = Math.max(0, Math.min(100 - field.heightPercent, (newTop / pageRect.height) * 100));

          if (over && over.pageNumber !== dragPage) {
            dragPage = over.pageNumber;
            onMoveToPage(over.pageNumber, xPercent, yPercent);
          } else {
            onMove(xPercent, yPercent);
          }
        },
      });
    },
    [onSelect, onMove, onMoveToPage, field.page, field.widthPercent, field.heightPercent]
  );

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      if (!e.isPrimary) return;
      e.preventDefault();
      e.stopPropagation();

      startPointerDrag(e, {
        onMove: (move) => {
          const parent = containerRef.current?.parentElement;
          if (!parent) return;
          const parentRect = parent.getBoundingClientRect();
          const newWidth = move.clientX - parentRect.left - left;
          const newHeight = move.clientY - parentRect.top - top;
          const maxSize = getMaxFieldSize(fieldType);
          const widthPercent = Math.max(5, Math.min(maxSize.maxWidth, 100 - field.xPercent, (newWidth / pageWidth) * 100));
          const heightPercent = Math.max(3, Math.min(maxSize.maxHeight, 100 - field.yPercent, (newHeight / pageHeight) * 100));
          onResize(widthPercent, heightPercent);
        },
      });
    },
    [onResize, field.xPercent, field.yPercent, fieldType, left, top, pageWidth, pageHeight]
  );

  return (
    <div
      ref={containerRef}
      data-signer-active={isSignerActive ? 'true' : 'false'}
      data-annotation="field"
      // touch-none so a finger dragging this moves it instead of panning the page.
      className={`absolute group touch-none transition-opacity cursor-move active:cursor-grabbing ${isSelected ? 'z-20' : 'z-10'} ${
        isSelected || isSignerActive ? 'opacity-100' : 'opacity-75'
      }`}
      style={{ left, top, width, height }}
      onPointerDown={handleDragStart}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
    >
      <div
        className={`absolute inset-0 rounded border-2 border-dashed flex items-center justify-center transition-colors ${color.border} ${color.bg}`}
      >
        {fieldType === 'signature' || fieldType === 'initials' ? (
          <div className={`absolute inset-0 ${color.text}`}>
            <SignatureVisual
              style={fieldStyle}
              placeholderText={fieldType === 'initials'
                ? 'Initial here'
                : fieldStyle === 'x-line'
                  ? 'Sign on line'
                  : 'Sign here'}
            />
          </div>
        ) : (
          <div className={`flex h-full w-full items-center justify-center px-2 text-center text-[11px] font-semibold uppercase tracking-[0.08em] ${color.text}`}>
            {field.label || getDefaultFieldLabel(fieldType)}
          </div>
        )}
      </div>

      {isSelected && (
        <div
          className="absolute left-0 -top-10 flex items-center gap-2 rounded-lg bg-surface shadow-lg ring-1 ring-outline-subtle py-1.5 pl-2.5 pr-1"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${color.solid}`} />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-on-surface-muted whitespace-nowrap">Assigned to</span>
          <Dropdown
            portal
            value={field.signerId ?? ""}
            onChange={(v) => onSignerChange(v)}
            onMouseDown={(e) => e.stopPropagation()}
            options={signers.map((s, i) => ({ label: signerPillLabel(s, i), value: s.participantId }))}
            className="w-auto"
            buttonClassName={`!px-2 !py-1 !rounded-md !text-[11px] !font-semibold !bg-surface-alt !border-transparent hover:!bg-surface-hover ${color.text}`}
            listClassName="text-[11px] min-w-[150px]"
          />
          <span className="h-4 w-px bg-outline-subtle shrink-0" />
          <button
            // Stops the drag beginning underneath, but must not cancel the event:
            // cancelling pointerdown can swallow the tap's click on touch.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            aria-label="Delete field"
            className="p-1 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer shrink-0"
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}

      {isSelected && (
        <div
          // before: widens the grab area well past the 12px dot for fingertips,
          // without changing what is drawn.
          className={`absolute -bottom-1.5 -right-1.5 w-3 h-3 ${color.solid} rounded-sm cursor-se-resize before:absolute before:-inset-2 before:content-['']`}
          onPointerDown={handleResizeStart}
        />
      )}
    </div>
  );
}

function SignerIdentityCard({
  signer,
  index,
  signersCount,
  routingMode,
  lawFirmId,
  members,
  onUpdate,
  onMove,
  onRemove,
}: {
  signer: DraftSigner;
  index: number;
  signersCount: number;
  routingMode: RoutingMode;
  lawFirmId: string;
  members: MemberOption[];
  onUpdate: (changes: Partial<DraftSigner>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const fieldIds = useId();
  const color = colorForSigner(index);
  const supportsAccessCode = signer.deliveryMethod === 'email' || signer.deliveryMethod === 'copy_link';
  const [showAccessCode, setShowAccessCode] = useState(() => Boolean(signer.accessCode));
  const isAccessCodeOpen = showAccessCode || Boolean(signer.accessCode);
  const deliveryChoice = signer.deliveryMethod === 'portal' || signer.deliveryMethod === 'internal_dashboard'
    ? 'paralegix'
    : signer.deliveryMethod;
  const deliveryExplanation = deliveryChoice === 'email'
    ? 'Sends a signing-request email to the address below. It does not add the request to a Paralegix dashboard or client portal.'
    : deliveryChoice === 'copy_link'
      ? 'Creates a unique signing link for you to copy and share. Paralegix sends no email or in-app notification.'
      : 'Adds the request to the selected client’s portal or team member’s dashboard. Paralegix sends no email.';

  return (
    <div className={`rounded-xl border-2 ${color.border} bg-surface-alt p-4 space-y-3`}>
      {/* Header. A single signer needs no role or reorder/delete controls, so
          show just a title; with multiple signers each carries an editable role
          (Client, Witness, etc.) plus reorder and remove controls. */}
      {signersCount > 1 ? (
        <div>
          <FieldLabel size="xs" tone="secondary">Label for this signer</FieldLabel>
          <div className="flex items-center gap-2.5">
            <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold shrink-0 ${color.badge}`}>
              {index + 1}
            </span>
            <input
              type="text"
              value={signer.roleLabel}
              onChange={(e) => onUpdate({ roleLabel: e.target.value, roleLabelAuto: false })}
              className="flex-1 min-w-0 rounded-md border border-input-border bg-input-bg text-on-surface px-2.5 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              placeholder="e.g. Client, Buyer, Witness"
            />
            <div className="flex items-center gap-0.5 shrink-0">
              {routingMode !== 'parallel' && (
                <>
                  <Tooltip title="Move up" enterDelay={300}>
                    <span>
                      <button aria-label="Move up"
                        onClick={() => onMove(-1)}
                        disabled={index === 0}
                        className="p-1 rounded text-on-surface-muted hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                      >
                        <ChevronUp size={14} />
                      </button>
                    </span>
                  </Tooltip>
                  <Tooltip title="Move down" enterDelay={300}>
                    <span>
                      <button aria-label="Move down"
                        onClick={() => onMove(1)}
                        disabled={index === signersCount - 1}
                        className="p-1 rounded text-on-surface-muted hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                      >
                        <ChevronDown size={14} />
                      </button>
                    </span>
                  </Tooltip>
                </>
              )}
              <Tooltip title="Remove signer" enterDelay={300}>
                <button aria-label="Remove signer"
                  onClick={onRemove}
                  className="p-1 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                >
                  <Trash2 size={14} />
                </button>
              </Tooltip>
            </div>
          </div>
          <p className="mt-1 text-[11px] text-on-surface-muted">
            Tags this signer on the signature fields so you can tell signers apart while placing them.
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-2.5">
          <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold shrink-0 ${color.badge}`}>
            {index + 1}
          </span>
          <span className="text-sm font-medium text-on-surface">Signer</span>
        </div>
      )}

      {/* Send via */}
      <div>
        <FieldLabel id={`${fieldIds}-send-via-label`} size="xs" tone="secondary">Send via</FieldLabel>
        <Dropdown
          ariaLabelledBy={`${fieldIds}-send-via-label`}
          portal
          value={deliveryChoice}
          onChange={(value) => {
            if (value === 'paralegix') {
              onUpdate({
                deliveryMethod: signer.selectedMemberId ? 'internal_dashboard' : 'portal',
                accessCode: '',
              });
              setShowAccessCode(false);
              return;
            }
            onUpdate({ deliveryMethod: value as SignerDeliveryMethod });
          }}
          options={[
            { label: 'Send via Email', value: 'email' },
            { label: 'Copy Signing Link', value: 'copy_link' },
            { label: 'Send in Paralegix', value: 'paralegix' },
          ]}
        />
        <p className="mt-1.5 text-xs leading-relaxed text-on-surface-muted">
          {deliveryExplanation}
        </p>
      </div>

      {/* Signer identity */}
      {(signer.deliveryMethod === 'email' || signer.deliveryMethod === 'copy_link') && (
        <>
          <div>
            <label className="mb-1 block text-xs font-normal text-on-surface-muted">
              Fill from
            </label>
            <SignerAutofillPicker
              lawFirmId={lawFirmId}
              members={members}
              onSelect={(identity) => onUpdate(identity)}
            />
          </div>
          <div className={signer.deliveryMethod === 'copy_link' ? '' : 'grid grid-cols-2 gap-3'}>
            <div>
              <FieldLabel htmlFor={`${fieldIds}-full-name`} size="xs" tone="secondary">
                Name{signer.deliveryMethod === 'copy_link' && ' *'}
              </FieldLabel>
              <input
                id={`${fieldIds}-full-name`}
                type="text"
                value={signer.name || ''}
                onChange={(e) => onUpdate({ name: e.target.value })}
                className="w-full rounded-md border border-input-border bg-input-bg text-on-surface px-2.5 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                placeholder="Full name"
              />
            </div>
            {signer.deliveryMethod !== 'copy_link' && (
              <div>
                <FieldLabel htmlFor={`${fieldIds}-signer-email`} size="xs" tone="secondary">
                  Email{signer.deliveryMethod === 'email' && ' *'}
                </FieldLabel>
                <input
                  id={`${fieldIds}-signer-email`}
                  type="email"
                  value={signer.email || ''}
                  onChange={(e) => onUpdate({ email: e.target.value })}
                  className="w-full rounded-md border border-input-border bg-input-bg text-on-surface px-2.5 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  placeholder="signer@example.com"
                />
              </div>
            )}
          </div>
        </>
      )}

      {/* Account-backed recipient picker */}
      {(signer.deliveryMethod === 'portal' || signer.deliveryMethod === 'internal_dashboard') && (
        <>
          <div>
            <FieldLabel size="xs" tone="secondary">Organization</FieldLabel>
            <EntityPicker
              entity="clients"
              lawFirmId={lawFirmId}
              clientType="company"
              excludeArchived
              portal
              value={signer.recipientOrgClientId || ''}
              onChange={(next) => onUpdate({ recipientOrgClientId: next || undefined })}
              emptyOption={{ label: 'All organizations', value: '' }}
              placeholder="All organizations"
            />
            <p className="mt-1 text-[11px] text-on-surface-muted">
              Shows only the people on one organization roster in the recipient list below.
            </p>
          </div>
          <div>
            <FieldLabel size="xs" tone="secondary">Paralegix recipient *</FieldLabel>
            <ParalegixRecipientPicker
              lawFirmId={lawFirmId}
              members={members}
              orgClientId={signer.recipientOrgClientId}
              selectedClient={signer.selectedClient}
              selectedMemberId={signer.selectedMemberId}
              onSelect={(selection) => {
                if (selection.kind === 'client') {
                  onUpdate({
                    deliveryMethod: 'portal',
                    selectedRecipientUserId: selection.client.userId,
                    selectedClient: selection.client,
                    selectedMemberId: undefined,
                    name: selection.client.name,
                    email: selection.client.email,
                    ...(signer.roleLabelAuto ? { roleLabel: 'Client' } : null),
                  });
                  return;
                }
                onUpdate({
                  deliveryMethod: 'internal_dashboard',
                  selectedRecipientUserId: undefined,
                  selectedClient: null,
                  selectedMemberId: selection.member.userId,
                  name: selection.member.name,
                  email: selection.member.email,
                  ...(signer.roleLabelAuto ? { roleLabel: 'Signer' } : null),
                });
              }}
            />
          </div>
        </>
      )}

      {/* Access code */}
      {supportsAccessCode && !isAccessCodeOpen && (
        <div className="flex items-center gap-2 pt-0.5">
          <button
            type="button"
            onClick={() => setShowAccessCode(true)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-emphasis hover:text-accent transition-[color,transform] active:scale-[0.98] motion-reduce:active:scale-100 cursor-pointer"
          >
            <Lock size={12} className="shrink-0" />
            <span>Add access code</span>
          </button>
          <Tooltip
            title="Require an access code to view and sign this document. You must share this code with the signer separately (via text, phone, etc.)."
            enterDelay={300}
          >
            <span
              tabIndex={0}
              aria-label="Access code information"
              role="button"
              className="inline-flex items-center text-on-surface-muted hover:text-on-surface cursor-help transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring rounded-full"
            >
              <Info size={13} />
            </span>
          </Tooltip>
        </div>
      )}

      {supportsAccessCode && isAccessCodeOpen && (
        <div className="rounded-lg border border-outline-subtle bg-surface/50 p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Lock size={12} className="text-on-surface-secondary shrink-0" />
              <label htmlFor={`${fieldIds}-access-code`} className="text-xs font-medium text-on-surface-secondary">
                Access code
              </label>
              <Tooltip
                title="The signer must enter this code before viewing or signing the document. Share it with them separately (e.g. via text, phone, or in person)."
                enterDelay={300}
              >
                <span
                  tabIndex={0}
                  aria-label="Access code information"
                  role="button"
                  className="inline-flex items-center text-on-surface-muted hover:text-on-surface cursor-help transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring rounded-full"
                >
                  <Info size={12} />
                </span>
              </Tooltip>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowAccessCode(false);
                onUpdate({ accessCode: '' });
              }}
              className="text-[11px] font-medium text-on-surface-muted hover:text-red-500 transition-colors cursor-pointer"
            >
              Remove
            </button>
          </div>
          <input
            id={`${fieldIds}-access-code`}
            type="text"
            placeholder="e.g. 6-digit code or phrase"
            value={signer.accessCode || ''}
            maxLength={20}
            autoFocus={!signer.accessCode}
            onChange={(e) => onUpdate({ accessCode: e.target.value })}
            className="w-full rounded-md border border-input-border bg-input-bg text-on-surface px-2.5 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring placeholder:text-on-surface-muted"
          />
          {signer.accessCode && signer.accessCode.trim().length > 0 && signer.accessCode.trim().length < 6 ? (
            <p className="text-[11px] text-red-500">Access code must be at least 6 characters.</p>
          ) : (
            <p className="text-[11px] text-on-surface-muted">
              Share this code with the signer separately. 6-20 characters.
            </p>
          )}
        </div>
      )}

    </div>
  );
}

export default function SignatureFieldPlacer({
  file,
  lawFirmId,
  objectPath,
  templateId,
  onBack,
  initialDestinationPath,
  initialDestinationLabel,
}: SignatureFieldPlacerProps) {
  const fieldIds = useId();
  const initialSignerRef = useRef<DraftSigner | null>(null);
  if (!initialSignerRef.current) {
    initialSignerRef.current = createDraftSigner(0, { roleLabel: 'Client' });
  }
  const [state, dispatch] = useReducer(fieldReducer, { fields: [], selectedId: null });
  const [defaultFieldType, setDefaultFieldType] = useState<FieldType>('signature');
  const [defaultFieldStyle, setDefaultFieldStyle] = useState<SignatureStyle>(DEFAULT_SIGNATURE_STYLE);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const { zoom, zoomIn, zoomOut, resetZoom, zoomAreaProps } = useDocumentZoom();
  const [selectedSignerId, setSelectedSignerId] = useState(() => initialSignerRef.current?.participantId || '');
  const [signers, setSigners] = useState<DraftSigner[]>(() => [initialSignerRef.current!]);
  const [routingMode, setRoutingMode] = useState<RoutingMode>('parallel');
  const [step, setStep] = useState<'signers' | 'fields' | 'review'>('signers');
  // What the signers step's own Back button should do depends on how the user
  // most recently arrived there. Edit Signers is a mid-flow detour, so Back
  // should return to fields. The fields step's own Back arrow is the user retreating
  // through the wizard, so a further Back from signers should behave like
  // the original entry point (discard-check / leave) rather than bouncing
  // forward to fields again. Set at each transition into signers below.
  const signersBackTargetsFieldsRef = useRef(false);
  const [emailSignersCopy, setEmailSignersCopy] = useState(true);
  const [copyLinks, setCopyLinks] = useState<{ participantId: string; name: string; link: string }[]>([]);
  // Once copy links exist the session is already created, so Escape/backdrop
  // must not drop back to the editor (whose Back flow implies nothing was
  // sent); leaving is the Done button's job.
  const closeReview = useCallback(() => {
    if (copyLinks.length === 0) setStep('fields');
  }, [copyLinks.length]);
  // Leaving the placer entirely throws away placed fields, so it asks first. Going
  // back from the fields step to the signers step does NOT: the fields live in this
  // component's reducer and survive the step change, so a prompt there would be
  // asking about a loss that does not happen.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [sending, setSending] = useState(false);
  // Set once the signing request itself has been created. Distinct from
  // sendSuccess, which the save-template toast also uses; keying the leave
  // guard on that opened a no-prompt window after every template save.
  const [requestSent, setRequestSent] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [destinationPath, setDestinationPath] = useState(initialDestinationPath || '');
  const [destinationLabel, setDestinationLabel] = useState(initialDestinationLabel || '');
  const [showDestinationPicker, setShowDestinationPicker] = useState(false);
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [pendingRemovalSignerId, setPendingRemovalSignerId] = useState<string | null>(null);

  // The browser's own Back gesture and a reload bypass the Back button above,
  // so they get the same question. Once the request has been sent the fields
  // live on the server and there is nothing left to lose.
  const { release: releaseLeaveGuard } = useUnsavedChangesGuard(
    state.fields.length > 0 && !requestSent,
    useCallback(() => setConfirmDiscard(true), [])
  );

  // Every deliberate departure goes through here so the browser's own leave
  // prompt doesn't fire on a navigation the user already chose.
  const leavePlacer = useCallback(() => {
    releaseLeaveGuard();
    onBack();
  }, [releaseLeaveGuard, onBack]);

  const signerFieldCounts = useMemo(() => {
    return signers.reduce<Record<string, number>>((acc, signer) => {
      acc[signer.participantId] = state.fields.filter((field) => field.signerId === signer.participantId).length;
      return acc;
    }, {});
  }, [signers, state.fields]);

  const signersWithoutFields = useMemo(() => {
    return signers.filter((signer) => (signerFieldCounts[signer.participantId] || 0) === 0);
  }, [signerFieldCounts, signers]);

  /**
   * Template fields sitting on pages this document does not have.
   *
   * Only meaningful for a document opened from a template: a layout saved against a
   * longer document keeps its fields, and nothing previously noticed. They were
   * never rendered, so they could not be selected or deleted, yet they were still
   * sent and stamped.
   */
  const orphanedTemplateFields = useMemo(
    () => (templateId ? fieldsOutsideDocument(state.fields, totalPages) : []),
    [templateId, state.fields, totalPages]
  );

  const fieldAssignmentError = useMemo(() => {
    if (orphanedTemplateFields.length > 0) {
      const count = orphanedTemplateFields.length;
      return `${count} field${count !== 1 ? 's' : ''} from this template sit${count === 1 ? 's' : ''} on a page this document does not have, so the signer could never fill ${count === 1 ? 'it' : 'them'} in. Use "Remove ${count === 1 ? 'it' : 'them'}" above the document.`;
    }

    if (state.fields.length === 0) {
      return 'Place at least one signature field before sending.';
    }

    if (state.fields.some((field) => !field.signerId)) {
      return 'Every signature field must be assigned to a signer.';
    }

    const emptySigner = signersWithoutFields[0];
    if (emptySigner) {
      const emptySignerIndex = signers.findIndex((signer) => signer.participantId === emptySigner.participantId);
      return `"${getSignerDisplayLabel(emptySigner, emptySignerIndex)}" has no fields assigned. Assign at least one field or remove this signer before sending.`;
    }

    return null;
  }, [orphanedTemplateFields, signers, signersWithoutFields, state.fields]);

  /**
   * The identity problem for each signer, aligned with `signers`.
   *
   * Split by whether the user has done something wrong: a portal client with no
   * portal account is a choice that cannot work and is worth reporting as soon as
   * it is picked, while a blank required field is true of every new signer row and
   * must not be announced before the form has been touched.
   */
  const signerIssues = useMemo(
    () => signers.map((signer, index) => signerIdentityIssue(signer, index)),
    [signers]
  );

  const signerIdentityBlockingError = useMemo(
    () => signerIssues.find((issue) => issue && !issue.incomplete)?.message ?? null,
    [signerIssues]
  );

  const signerIdentityIncompleteError = useMemo(
    () => signerIssues.find((issue) => issue?.incomplete)?.message ?? null,
    [signerIssues]
  );

  const signerIdentityError = signerIdentityBlockingError || signerIdentityIncompleteError;

  const sendValidationError = useMemo(
    () => fieldAssignmentError || signerIdentityError,
    [fieldAssignmentError, signerIdentityError]
  );

  const copyLinkSignerCount = signers.filter((signer) => signer.deliveryMethod === 'copy_link').length;
  const allSignersUseCopyLinks = copyLinkSignerCount === signers.length;
  const primaryActionLabel = allSignersUseCopyLinks
    ? `Generate Signing Link${copyLinkSignerCount === 1 ? '' : 's'}`
    : copyLinkSignerCount > 0
      ? `Send & Generate Link${copyLinkSignerCount === 1 ? '' : 's'}`
      : 'Send for Signing';
  const primaryActionBusyLabel = allSignersUseCopyLinks ? 'Generating...' : 'Sending...';


  const removeSignerError = useMemo(() => {
    if (!pendingRemovalSignerId) return null;

    const signerStillHasFields = (signerFieldCounts[pendingRemovalSignerId] || 0) > 0;
    return signerStillHasFields ? 'Reassign or delete this signer’s fields before removing them.' : null;
  }, [pendingRemovalSignerId, signerFieldCounts]);

  /**
   * What the review panel reports: a failed request, a removal to resolve, unassigned
   * fields, or a signer choice that cannot work.
   *
   * `signerIdentityIncompleteError` is deliberately absent. It is true from the
   * moment an email signer exists with an empty email, so showing it announced
   * "Enter an email address" before the user had touched anything; its only job is
   * to keep Send disabled until the form is complete.
   */
  const deliveryPanelError = removeSignerError || requestError || fieldAssignmentError || signerIdentityBlockingError;
  const activePlacementSigner = signers.find((signer) => signer.participantId === selectedSignerId) || signers[0];

  // The field-tools toolbar edits the selected field when one is selected, and
  // otherwise sets the type/style used for the next field placed. These derive
  // what the toolbar highlights so it reflects the selected field's current
  // type/style rather than only the placement defaults.
  const selectedField = state.selectedId
    ? state.fields.find((field) => field.id === state.selectedId) ?? null
    : null;
  const toolbarFieldType = selectedField?.fieldType || defaultFieldType;

 const toolbarFieldStyle = resolveSignatureStyle(selectedField ? selectedField.style : defaultFieldStyle);

  const handleFieldTypeSelect = useCallback((type: FieldType) => {
    setDefaultFieldType(type);
    if (!selectedField || (selectedField.fieldType || 'signature') === type) return;
    const size = getDefaultFieldSize(type);
    const placement = clampFieldPlacement(selectedField.xPercent, selectedField.yPercent, size.widthPercent, size.heightPercent);
    dispatch({
      type: 'UPDATE',
      id: selectedField.id,
      changes: {
        fieldType: type,
        label: getDefaultFieldLabel(type),
        xPercent: placement.xPercent,
        yPercent: placement.yPercent,
        widthPercent: placement.widthPercent,
        heightPercent: placement.heightPercent,
        style: type === 'signature' || type === 'initials'
          ? resolveSignatureStyle(selectedField.style ?? defaultFieldStyle)
          : undefined,
      },
    });
  }, [defaultFieldStyle, selectedField]);

  const handleFieldStyleSelect = useCallback((style: SignatureStyle) => {
    setDefaultFieldStyle(style);
    if (selectedField && (selectedField.fieldType === 'signature' || selectedField.fieldType === 'initials')) {
      dispatch({ type: 'STYLE', id: selectedField.id, style });
    }
  }, [selectedField]);

  useEffect(() => {
    if (!templateId) return;

    let cancelled = false;

    (async () => {
      setLoadingTemplate(true);
      setRequestError(null);
      try {
        const { template } = await signaturesService.getSigningTemplate(lawFirmId, templateId);
        if (cancelled) return;

        const sortedRoles = (template.signerRoles || []).slice().sort((a, b) => a.order - b.order);
        const hydratedSigners = sortedRoles.length > 0
          ? normalizeSignerOrders(
              sortedRoles.map((role, index) => createDraftSigner(index, {
                roleLabel: role.roleLabel,
                roleLabelAuto: false,
                deliveryMethod: role.deliveryMethod === 'internal_email'
                  ? 'email'
                  : role.deliveryMethod === 'in_person'
                    ? 'copy_link'
                    : role.deliveryMethod || 'email',
              }))
            )
          : [createDraftSigner(0, { roleLabel: 'Client' })];

        // Keyed by each role's ORIGINAL order, which is what the stored
        // "role:N" field refs carry. The normalized 1..n orders diverge from
        // it when a template's role orders are non-contiguous, and keying on
        // them silently dropped those fields onto the first signer.
        const roleIdByOrder = new Map<number, string>();
        sortedRoles.forEach((role, index) => {
          const signer = hydratedSigners[index];
          if (signer) roleIdByOrder.set(role.order, signer.participantId);
        });

        const hydratedFields = (template.fields || []).map((field) => {
          const signerId = resolveTemplateSignerId(
            field.signerId,
            template.signerRoles || [],
            roleIdByOrder,
          ) || hydratedSigners[0]?.participantId;

          return {
            ...field,
            fieldType: field.fieldType || 'signature',
            label: field.label || getDefaultFieldLabel(field.fieldType || 'signature'),
            required: field.required !== false,
            signerId,
          };
        });

        setSigners(hydratedSigners);
        setSelectedSignerId(hydratedSigners[0]?.participantId || '');
        setRoutingMode(template.routingMode || 'parallel');
        dispatch({
          type: 'REPLACE_ALL',
          fields: hydratedFields,
          selectedId: null,
        });
      } catch (err) {
        if (!cancelled) {
          setRequestError(getErrorMessage(err, 'Failed to load signing template'));
        }
      } finally {
        if (!cancelled) setLoadingTemplate(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lawFirmId, templateId]);

  // Only team members are preloaded. Portal clients come from the picker's own
  // server typeahead, which stays usable for firms with thousands of clients.
  const loadRecipients = useCallback(async () => {
    setLoadingRecipients(true);
    try {
      const membersResult = await lawFirmService.getLawFirmMembers(lawFirmId);
      setMembers(membersResult.map((member) => ({
        userId: member.userId || member.id,
        name: member.name || member.email || 'Team Member',
        email: member.email || '',
      })));
    } catch (err) {
      setRequestError(getErrorMessage(err, 'Failed to load recipients'));
    } finally {
      setLoadingRecipients(false);
    }
  }, [lawFirmId]);

  useEffect(() => {
    if (!pendingRemovalSignerId) return;
    if ((signerFieldCounts[pendingRemovalSignerId] || 0) === 0 || !signers.some((signer) => signer.participantId === pendingRemovalSignerId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- dismisses the pending-removal confirmation once the signer has no fields or is gone
      setPendingRemovalSignerId(null);
    }
  }, [pendingRemovalSignerId, signerFieldCounts, signers]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- triggers async recipient load (which sets state); the signers step needs clients/members immediately
    loadRecipients();
  }, [loadRecipients]);

  useEffect(() => {
    if (!sendSuccess || copyLinks.length > 0) return;
    const timeout = window.setTimeout(() => { setSendSuccess(null); }, 3500);
    return () => window.clearTimeout(timeout);
  }, [sendSuccess, copyLinks]);


  const handlePageClick = useCallback(
    (page: number, xPercent: number, yPercent: number, widthPercent?: number, heightPercent?: number) => {
      const defaultSize = getDefaultFieldSize(defaultFieldType);
      // Same per-type ceiling the resize handle enforces; without it a
      // drag-created field could start far larger than resizing allows.
      const maxSize = getMaxFieldSize(defaultFieldType);
      const placement = clampFieldPlacement(
        xPercent,
        yPercent,
        Math.min(widthPercent ?? defaultSize.widthPercent, maxSize.maxWidth),
        Math.min(heightPercent ?? defaultSize.heightPercent, maxSize.maxHeight),
      );

      dispatch({
        type: 'ADD',
        field: {
          id: genFieldId(),
          page,
          xPercent: placement.xPercent,
          yPercent: placement.yPercent,
          widthPercent: placement.widthPercent,
          heightPercent: placement.heightPercent,
          fieldType: defaultFieldType,
          label: getDefaultFieldLabel(defaultFieldType),
          required: true,
          style: defaultFieldType === 'signature' || defaultFieldType === 'initials' ? defaultFieldStyle : undefined,
          signerId: activePlacementSigner?.participantId,
        },
      });
    },
    [activePlacementSigner?.participantId, defaultFieldStyle, defaultFieldType]
  );

  // Selecting a field, or reassigning one, also makes that signer the active
  // placement signer. Whichever control the user last picked a signer through
  // (the pills, a placed field, or the field's "Assigned to" dropdown), the
  // next field placed goes to that person rather than a previously active one.
  const selectField = useCallback((field: SignatureField) => {
    dispatch({ type: 'SELECT', id: field.id });
    if (field.signerId) setSelectedSignerId(field.signerId);
  }, []);

  const assignFieldSigner = useCallback((fieldId: string, signerId: string) => {
    dispatch({ type: 'ASSIGN_SIGNER', id: fieldId, signerId });
    setSelectedSignerId(signerId);
  }, []);

  const updateSigner = useCallback((participantId: string, changes: Partial<DraftSigner>) => {
    setRequestError(null);
    setSigners((prev) => prev.map((signer) => (
      signer.participantId === participantId ? { ...signer, ...changes } : signer
    )));
  }, []);

  const addSigner = useCallback(() => {
    setRequestError(null);
    const newSigner = createDraftSigner(signers.length, { deliveryMethod: 'email', roleLabel: 'Signer' });
    setSigners((prev) => normalizeSignerOrders([...prev, newSigner]));
    setSelectedSignerId(newSigner.participantId);
    dispatch({ type: 'SELECT', id: null });
  }, [signers.length]);

  const moveSigner = useCallback((participantId: string, direction: -1 | 1) => {
    setSigners((prev) => {
      const index = prev.findIndex((signer) => signer.participantId === participantId);
      if (index < 0) return prev;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(index, 1);
      next.splice(nextIndex, 0, moved);
      return normalizeSignerOrders(next);
    });
  }, []);

  const removeSignerAndFields = useCallback((participantId: string) => {
    if (signers.length === 1) {
      setRequestError('At least one signer is required.');
      return;
    }

    setRequestError(null);
    setPendingRemovalSignerId(null);

    const remainingSigners = normalizeSignerOrders(signers.filter((signer) => signer.participantId !== participantId));
    const remainingFields = state.fields.filter((field) => field.signerId !== participantId);
    const selectedFieldStillExists = state.selectedId && remainingFields.some((field) => field.id === state.selectedId);

    setSigners(remainingSigners);
    dispatch({
      type: 'REPLACE_ALL',
      fields: remainingFields,
      selectedId: selectedFieldStillExists ? state.selectedId : null,
    });

    if (selectedSignerId === participantId) {
      setSelectedSignerId(remainingSigners[0]?.participantId || '');
    }
  }, [selectedSignerId, signers, state.fields, state.selectedId]);

  const removeSigner = useCallback((participantId: string) => {
    if (signers.length === 1) {
      setRequestError('At least one signer is required.');
      return;
    }
    if ((signerFieldCounts[participantId] || 0) > 0) {
      setPendingRemovalSignerId(participantId);
      // The signers step renders requestError, not removeSignerError, so without
      // this the remove button would appear to do nothing there.
      setRequestError('Reassign or delete this signer’s fields before removing them.');
      return;
    }
    setRequestError(null);
    setPendingRemovalSignerId(null);
    setSigners((prev) => normalizeSignerOrders(prev.filter((signer) => signer.participantId !== participantId)));
    if (selectedSignerId === participantId) {
      const nextSigner = signers.find((signer) => signer.participantId !== participantId);
      if (nextSigner) setSelectedSignerId(nextSigner.participantId);
    }
  }, [selectedSignerId, signerFieldCounts, signers]);

  const buildSignerPayload = useCallback(() => {
    return signers.map((signer, index) => {
      const roleLabel = signer.roleLabel.trim() || `Signer ${index + 1}`;
      const accessCode = signer.accessCode?.trim();

      if (signer.deliveryMethod === 'portal') {
        const resolved = resolvePortalSigner(signer, roleLabel);
        if (!resolved.ok) {
          throw new Error(resolved.error);
        }
        return {
          participantId: signer.participantId,
          roleLabel,
          order: index + 1,
          deliveryMethod: signer.deliveryMethod,
          name: resolved.client.name,
          email: resolved.client.email || undefined,
          clientUserId: resolved.clientUserId,
        };
      }

      if (signer.deliveryMethod === 'internal_dashboard') {
        const selectedMember = members.find((member) => member.userId === signer.selectedMemberId);
        if (!selectedMember) {
          throw new Error(`Select a team member for ${roleLabel}.`);
        }
        return {
          participantId: signer.participantId,
          roleLabel,
          order: index + 1,
          deliveryMethod: signer.deliveryMethod,
          name: selectedMember.name,
          email: selectedMember.email || undefined,
          memberUserId: selectedMember.userId,
        };
      }

      if (signer.deliveryMethod === 'copy_link') {
        if (!signer.name?.trim()) {
          throw new Error(`Enter a signer name for ${roleLabel}.`);
        }

        if (accessCode && accessCode.length < 6) {
          throw new Error(`Access code for ${roleLabel} must be at least 6 characters.`);
        }

        return {
          participantId: signer.participantId,
          roleLabel,
          order: index + 1,
          deliveryMethod: signer.deliveryMethod,
          name: signer.name.trim(),
          email: undefined,
          accessCode: accessCode || undefined,
        };
      }

      if (!signer.email?.trim()) {
        throw new Error(`Enter an email address for ${roleLabel}.`);
      }

      if (accessCode && accessCode.length < 6) {
        throw new Error(`Access code for ${roleLabel} must be at least 6 characters.`);
      }

      return {
        participantId: signer.participantId,
        roleLabel,
        order: index + 1,
        deliveryMethod: signer.deliveryMethod,
        name: signer.name?.trim() || undefined,
        email: signer.email.trim(),
        accessCode: accessCode || undefined,
      };
    });
  }, [members, signers]);

  const validateBeforeSend = useCallback(() => {
    if (fieldAssignmentError) {
      throw new Error(fieldAssignmentError);
    }
  }, [fieldAssignmentError]);

  const handleSend = useCallback(async () => {
    setRequestError(null);
    setSendSuccess(null);
    try {
      if (sendValidationError) {
        return;
      }
      const signerPayload = buildSignerPayload();
      setSending(true);
      const result = await signaturesService.sendSigningRequest(lawFirmId, {
        objectPath,
        fileName: file.name,
        fields: state.fields,
        signers: signerPayload,
        routingMode,
        destinationPath: destinationPath || undefined,
        destinationLabel: destinationLabel || undefined,
        emailSignersOnComplete: emailSignersCopy,
      });

      setRequestSent(true);
      if (result.copyLinks && result.copyLinks.length > 0) {
        setCopyLinks(result.copyLinks);
        setSendSuccess('Signing request created. Copy the link(s) below to share with your signer(s).');
        // Keep the review modal open so user can copy links
      } else {
        // Sent with no copy-links to surface, return to the signatures (e-sign)
        // page rather than leaving the user on the field-placement view.
        leavePlacer();
      }
    } catch (err) {
      setRequestError(getErrorMessage(err, 'Failed to send signing request'));
    } finally {
      setSending(false);
    }
  }, [buildSignerPayload, destinationLabel, destinationPath, emailSignersCopy, file.name, lawFirmId, objectPath, leavePlacer, routingMode, sendValidationError, state.fields]);

  // The links stay in place: leaving is a page navigation that takes a moment
  // to land, and emptying them first flips the review dialog back to the send
  // form, with a live Send button, for a request that has already been sent.
  const handleDeliveryDone = useCallback(() => {
    setSendSuccess(null);
    leavePlacer();
  }, [leavePlacer]);

  const handleSaveTemplate = useCallback(async () => {
    if (savingTemplate) return;
    setRequestError(null);

    try {
      validateBeforeSend();
      if (!templateName.trim()) {
        throw new Error('Enter a template name.');
      }

      setSavingTemplate(true);

      const signerRoles = signers.map((signer, index) => ({
        roleLabel: signer.roleLabel.trim() || `Signer ${index + 1}`,
        order: index + 1,
        deliveryMethod: signer.deliveryMethod,
      }));

      const fieldRoleMap = new Map(
        signers.map((signer, index) => [signer.participantId, createTemplateRoleRef(signerRoles[index]?.order || index + 1)])
      );

      await signaturesService.createSigningTemplate(lawFirmId, {
        name: templateName.trim(),
        description: templateDescription.trim() || undefined,
        sourceFileName: file.name,
        sourceObjectPath: objectPath,
        routingMode,
        signerRoles,
        fields: state.fields.map((field) => ({
          ...field,
          fieldType: field.fieldType || 'signature',
          label: field.label || getDefaultFieldLabel(field.fieldType || 'signature'),
          required: field.required !== false,
          signerId: field.signerId ? fieldRoleMap.get(field.signerId) : undefined,
        })),
      });

      // The signatures/templates pages cache their list under a separate
      // QueryClient; flag it so the just-saved template shows on return.
      markSigningTemplatesDirty(lawFirmId);
      setShowSaveTemplate(false);
      setTemplateName('');
      setTemplateDescription('');
      setSendSuccess('Template saved for future signing requests.');
    } catch (err) {
      setRequestError(getErrorMessage(err, 'Failed to save signing template'));
    } finally {
      setSavingTemplate(false);
    }
  }, [file.name, lawFirmId, objectPath, routingMode, savingTemplate, signers, state.fields, templateDescription, templateName, validateBeforeSend]);

  return (
    <div className="flex-1 flex flex-col">
      {step === 'signers' && (
        <div className="flex-1 overflow-auto bg-page">
          <div className="max-w-3xl mx-auto p-6 space-y-4">
            <div className="flex items-center gap-3">
              <Tooltip title="Back" enterDelay={300}>
                <button aria-label="Back"
                  onClick={() => {
                    if (signersBackTargetsFieldsRef.current) { setStep('fields'); return; }
                    if (state.fields.length > 0) { setConfirmDiscard(true); return; }
                    leavePlacer();
                  }}
                  className="p-1.5 rounded-lg text-on-surface-muted hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer shrink-0"
                >
                  <ArrowLeft size={18} />
                </button>
              </Tooltip>
              <div>
                <h2 className="text-lg font-semibold text-on-surface">Who needs to sign?</h2>
                <p className="text-sm text-on-surface-muted">{file.name}</p>
              </div>
            </div>

            {requestError && (
              <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-100 dark:bg-red-950 px-4 py-2.5 text-sm text-red-700 dark:text-red-400">
                {requestError}
              </div>
            )}

            <div className="rounded-xl border border-outline-subtle bg-surface-alt p-4 space-y-3">
              <p className="text-sm font-semibold text-on-surface">Routing Mode</p>
              <div className="flex items-center rounded-lg bg-page p-1 gap-1">
                <button
                  onClick={() => setRoutingMode('parallel')}
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
                    routingMode === 'parallel'
                      ? 'bg-accent-solid text-accent-foreground'
                      : 'text-on-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  Parallel
                </button>
                <button
                  onClick={() => setRoutingMode('sequential')}
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer ${
                    routingMode === 'sequential'
                      ? 'bg-accent-solid text-accent-foreground'
                      : 'text-on-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  Sequential
                </button>
              </div>
              <p className="text-xs text-on-surface-muted">
                {routingMode === 'parallel'
                  ? 'All signers receive the document immediately and can sign independently.'
                  : 'Each signer becomes active only after the previous signer finishes.'}
              </p>
            </div>

            {/* Also gated on the template fetch: it replaces the signer list
                wholesale when it lands, so cards editable before then would
                have their edits silently discarded. */}
            {loadingRecipients || loadingTemplate ? (
              <div className="flex items-center gap-2 py-4 text-sm text-on-surface-muted">
                <Spinner size={16} /> {loadingTemplate ? 'Loading template...' : 'Loading team members...'}
              </div>
            ) : (
              signers.map((signer, index) => (
                <SignerIdentityCard
                  key={signer.participantId}
                  signer={signer}
                  index={index}
                  signersCount={signers.length}
                  routingMode={routingMode}
                  lawFirmId={lawFirmId}
                  members={members}
                  onUpdate={(changes) => updateSigner(signer.participantId, changes)}
                  onMove={(direction) => moveSigner(signer.participantId, direction)}
                  onRemove={() => removeSigner(signer.participantId)}
                />
              ))
            )}

            <button
              onClick={addSigner}
              disabled={loadingTemplate}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-outline px-4 py-3 text-sm font-medium text-on-surface-secondary hover:border-accent-border-soft hover:text-accent-emphasis dark:hover:text-accent-emphasis-hover disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,border-color,color,transform] duration-100 active:scale-[0.99] motion-reduce:active:scale-100 cursor-pointer"
            >
              <Plus size={15} /> Add Signer
            </button>

            {/* Only the blocking kind. A blank required field is marked with an
                asterisk and keeps the button disabled; saying it out loud here read
                as an error before anything had been typed. */}
            <div className="flex items-center justify-between gap-3 pt-2">
              {signerIdentityBlockingError ? (
                <FieldError message={signerIdentityBlockingError} className="mt-0" />
              ) : <span />}
              <button
                onClick={() => { setRequestError(null); setStep('fields'); }}
                disabled={Boolean(signerIdentityError) || loadingRecipients || loadingTemplate}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
              >
                Continue to Place Fields
              </button>
            </div>
          </div>
        </div>
      )}

      {step !== 'signers' && (
      <>
      <div
        className="sticky top-0 z-30 bg-surface border-b border-outline-subtle"
        onClick={(e) => {
          // Clicking inert areas of the header clears the selection, except the
          // field-edit controls (marked data-keep-selection) which act on it.
          if (state.selectedId && !(e.target as HTMLElement).closest('[data-keep-selection]')) {
            dispatch({ type: 'SELECT', id: null });
          }
        }}
      >
        {/* Top row: navigation + actions */}
        <div className="px-4 py-2.5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Tooltip title="Back" enterDelay={300}>
              <button aria-label="Back"
                onClick={() => { signersBackTargetsFieldsRef.current = false; setStep('signers'); }}
                className="p-1.5 rounded-lg text-on-surface-muted hover:bg-surface-hover transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer shrink-0"
              >
                <ArrowLeft size={18} />
              </button>
            </Tooltip>
            <div className="h-5 w-px bg-outline-subtle shrink-0" />
            <span className="text-sm font-medium text-on-surface truncate">{file.name}</span>
            <span className="text-[11px] text-on-surface-muted hidden sm:inline shrink-0">
              {loadingTemplate
                ? 'Loading template...'
                : routingMode === 'parallel'
                  ? 'Parallel routing'
                  : 'Sequential routing'}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => { signersBackTargetsFieldsRef.current = true; setStep('signers'); }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-outline-subtle text-xs font-medium text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer whitespace-nowrap"
            >
              Edit Signers
            </button>
            <button
              onClick={() => { setRequestError(null); setShowSaveTemplate(true); }}
              disabled={state.fields.length === 0}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-outline-subtle text-xs font-medium text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer whitespace-nowrap"
            >
              <BookmarkPlus size={13} />
              Save Template
            </button>
            <button
              // An abandoned removal (trash clicked, fields never reassigned) is
              // not a send blocker; carrying it into review showed a stale error
              // above an enabled Send button.
              onClick={() => { setPendingRemovalSignerId(null); setStep('review'); }}
              disabled={state.fields.length === 0}
              className="px-3.5 py-1.5 text-xs font-medium rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              Continue
            </button>
          </div>
        </div>

        <div className="border-t border-outline-subtle/50 bg-surface-alt/20 px-4 py-2">
          <div className="flex items-center gap-2 overflow-x-auto styled-scrollbar">
            <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] text-on-surface-muted">
              Signers
            </span>
            {signers.map((signer, index) => {
              const color = colorForSigner(index);
              const isSelected = selectedSignerId === signer.participantId;
              const fieldCount = signerFieldCounts[signer.participantId] || 0;
              const signerLabel = signerPillLabel(signer, index);

              return (
                <div
                  key={signer.participantId}
                  className={`shrink-0 flex items-center rounded-full border text-xs ${
                    isSelected
                      ? 'border-accent-solid bg-accent-soft'
                      : 'border-outline-subtle bg-surface'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => { setSelectedSignerId(signer.participantId); dispatch({ type: 'SELECT', id: null }); }}
                    aria-label={`Placing for ${signerLabel}`}
                    className={`rounded-l-full px-3 py-1.5 transition-colors cursor-pointer ${
                      isSelected
                        ? 'text-on-surface'
                        : 'text-on-surface-secondary hover:bg-surface-hover hover:text-on-surface'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold ${color.badge}`}>
                        {index + 1}
                      </span>
                      <span className="font-medium">{signerLabel}</span>
                      <span className={fieldCount > 0 ? 'text-on-surface-muted' : 'text-red-500'}>
                        {fieldCount} field{fieldCount !== 1 ? 's' : ''}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeSignerAndFields(signer.participantId)}
                    disabled={signers.length === 1}
                    aria-label={`Delete ${signerLabel}`}
                    title={signers.length === 1 ? 'At least one signer is required' : `Delete ${signerLabel} and their fields`}
                    className="rounded-r-full border-l border-outline-subtle px-2.5 py-1.5 text-red-500 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-red-900/20"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={addSigner}
              aria-label="Add signer"
              className="shrink-0 inline-flex items-center gap-2 rounded-full border border-dashed border-outline px-3 py-1.5 text-xs font-medium text-on-surface-secondary transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 hover:border-accent-border-soft hover:bg-surface-hover hover:text-accent-emphasis dark:hover:text-accent-emphasis-hover cursor-pointer"
            >
              <Plus size={12} />
              Add signer
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-on-surface-muted">
            Placing fields for{' '}
            <span className="font-medium text-on-surface">
              {signerPillLabel(activePlacementSigner, Math.max(0, signers.findIndex((s) => s.participantId === activePlacementSigner.participantId)))}
            </span>
            . Click a signer above to switch, or click a placed field to edit its type, move, or reassign it.
          </p>
        </div>

        {/* Bottom row: field tools */}
        <div className="px-4 py-1.5 flex flex-wrap items-center justify-center gap-2 border-t border-outline-subtle/50 bg-surface-alt/30">
          <span data-keep-selection className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-on-surface-muted">
            {selectedField ? 'Edit field' : 'New field'}
          </span>
          <div data-keep-selection className="flex items-center rounded-lg bg-surface-alt p-1 gap-0.5">
            {FIELD_TYPE_OPTIONS.map((option) => {
              const Icon = option.icon;
              const isActive = toolbarFieldType === option.type;

              return (
                <button
                  key={option.type}
                  onClick={() => handleFieldTypeSelect(option.type)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-accent-solid text-accent-foreground shadow-sm'
                      : 'text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover'
                  }`}
                >
                  <Icon size={13} />
                  {option.label}
                </button>
              );
            })}
          </div>

          {['signature', 'initials'].includes(toolbarFieldType) && (
            <>
              <div className="h-4 w-px bg-outline-subtle" />
              <div data-keep-selection className="flex items-center rounded-lg bg-surface-alt p-1 gap-0.5">
                <button
                  onClick={() => handleFieldStyleSelect('standard')}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    toolbarFieldStyle === 'standard'
                      ? 'bg-accent-solid text-accent-foreground shadow-sm'
                      : 'text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover'
                  }`}
                >
                  Signature
                </button>
                <button
                  onClick={() => handleFieldStyleSelect('x-line')}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                    toolbarFieldStyle === 'x-line'
                      ? 'bg-accent-solid text-accent-foreground shadow-sm'
                      : 'text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover'
                  }`}
                >
                  X + line
                </button>
              </div>
            </>
          )}

          <div className="h-4 w-px shrink-0 bg-outline-subtle" />

          <ZoomControls className="shrink-0" zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} />

          <div className="h-4 w-px shrink-0 bg-outline-subtle" />

          <span className="text-xs text-on-surface-muted">
            {state.fields.length} field{state.fields.length !== 1 ? 's' : ''} placed
          </span>

          {/* Said here rather than only at Review & Send, because deleting them is
              done on the document and the reader is looking at it now. */}
          {orphanedTemplateFields.length > 0 && (
            <>
              <div className="h-4 w-px shrink-0 bg-outline-subtle" />
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                <AlertCircle size={13} />
                {orphanedTemplateFields.length} field{orphanedTemplateFields.length !== 1 ? 's' : ''} past the last page
              </span>
              {/* Without this the warning is a dead end: an orphaned field sits on a
                  page that does not render, so it can never be selected and the
                  instruction to delete it cannot be followed. */}
              <button
                type="button"
                onClick={() => orphanedTemplateFields.forEach((field) => dispatch({ type: 'DELETE', id: field.id }))}
                className="shrink-0 text-xs font-medium text-amber-700 underline decoration-dotted hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200 cursor-pointer"
              >
                Remove {orphanedTemplateFields.length !== 1 ? 'them' : 'it'}
              </button>
            </>
          )}

          {/* A readout, not a control: the document scrolls, so this says where you
              are rather than offering to move you. */}
          {totalPages > 1 && (
            <>
              <div className="h-4 w-px shrink-0 bg-outline-subtle" />
              <span className="shrink-0 text-xs tabular-nums text-on-surface-muted">
                Page {currentPage} of {totalPages}
              </span>
            </>
          )}

          <Tooltip title="Delete selected field" enterDelay={300}>
            <button aria-label="Delete selected field"
              onClick={() => state.selectedId && dispatch({ type: 'DELETE', id: state.selectedId })}
              className={`p-1 rounded-md text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all active:scale-[0.96] motion-reduce:active:scale-100 ${
                state.selectedId ? 'opacity-100 cursor-pointer' : 'opacity-0 pointer-events-none'
              }`}
            >
              <Trash2 size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      {sendSuccess && !copyLinks.length && (
        <div className="pointer-events-none fixed right-6 top-24 z-40 flex justify-end">
          <div className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-950/95 px-4 py-3 shadow-2xl shadow-emerald-950/30 backdrop-blur">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/18 text-emerald-300">
              <Check size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-emerald-200">Success</p>
              <p className="mt-0.5 text-sm leading-5 text-emerald-100/90">{sendSuccess}</p>
            </div>
            <button
              type="button"
              onClick={() => setSendSuccess(null)}
              className="rounded-lg p-1.5 text-emerald-200/80 transition-[background-color,color,transform] hover:bg-white/6 hover:text-white active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
              aria-label="Dismiss success message"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {requestError && (
        <div className="mx-4 my-3 rounded-lg border border-red-300 dark:border-red-700 bg-red-100 dark:bg-red-950 px-4 py-2.5 text-sm text-red-700 dark:text-red-400">
          {requestError}
        </div>
      )}

      <ScrollArea
        viewportProps={zoomAreaProps}
        className="flex-1 bg-gray-100 dark:bg-gray-900"
        viewportClassName="p-6"
        onClick={(e) => {
          // Clicking the empty area around the page (not the page or a field)
          // clears the current selection.
          if (state.selectedId && !(e.target as HTMLElement).closest('[data-pdf-page]')) {
            dispatch({ type: 'SELECT', id: null });
          }
        }}
      >
        <PDFPageViewer
          file={file}
          mode={'signature' as ToolMode}
          zoom={zoom}
          onDocumentLoad={(numPages) => setTotalPages(numPages)}
          onVisiblePageChange={setCurrentPage}
          onPageClick={handlePageClick}
        >
          {(page, pageWidth, pageHeight) => (
            <>
              {state.fields.filter((field) => field.page === page).map((field) => {
                const signerIndex = Math.max(0, signers.findIndex((signer) => signer.participantId === field.signerId));
                return (
                  <FieldOverlay
                    key={field.id}
                    field={field}
                    colorIndex={signerIndex}
                    isSelected={state.selectedId === field.id}
                    isSignerActive={field.signerId === selectedSignerId}
                    pageWidth={pageWidth}
                    pageHeight={pageHeight}
                    signers={signers}
                    onSelect={() => selectField(field)}
                    onMove={(x, y) => dispatch({ type: 'MOVE', id: field.id, xPercent: x, yPercent: y })}
                    onMoveToPage={(page, x, y) => dispatch({ type: 'MOVE_TO_PAGE', id: field.id, page, xPercent: x, yPercent: y })}
                    onResize={(w, h) => dispatch({ type: 'RESIZE', id: field.id, widthPercent: w, heightPercent: h })}
                    onSignerChange={(signerId) => assignFieldSigner(field.id, signerId)}
                    onDelete={() => dispatch({ type: 'DELETE', id: field.id })}
                  />
                );
              })}
            </>
          )}
        </PDFPageViewer>
      </ScrollArea>
      </>
      )}

      <Modal
        isOpen={step === 'review'}
        onClose={closeReview}
        dismissible={!sending}
        title="Review & Send"
        subtitle="Confirm signers, choose where the signed file is saved, then send."
        size="4xl"
        closeIcon={<X size={18} strokeWidth={2} />}
        bodyClassName="px-6 py-5 overflow-y-auto overflow-x-hidden styled-scrollbar"
        footer={
          <div className="w-full flex flex-col gap-3">
            {(deliveryPanelError || sendValidationError) && !copyLinks.length && (
              <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
                <AlertCircle size={14} className="mt-px shrink-0" />
                <span>{deliveryPanelError || sendValidationError}</span>
              </div>
            )}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-on-surface-muted">
                {signers.length} signer{signers.length !== 1 ? 's' : ''}
                {' · '}
                {state.fields.length} field{state.fields.length !== 1 ? 's' : ''} placed
                {' · '}
                <span className="capitalize">{routingMode}</span>
              </p>
              {copyLinks.length > 0 ? (
                <button
                  onClick={handleDeliveryDone}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent-solid px-5 py-2.5 text-sm font-medium text-accent-foreground transition-[background-color,transform] hover:bg-accent-solid-hover active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                >
                  Done
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  // totalPages === 0 means the document has not reported its
                  // page count yet, so the orphaned-template-field check has
                  // nothing to compare against and must not be raced past.
                  disabled={sending || loadingRecipients || loadingTemplate || totalPages === 0 || Boolean(sendValidationError)}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent-solid px-5 py-2.5 text-sm font-medium text-accent-foreground transition-[background-color,transform] hover:bg-accent-solid-hover active:scale-[0.96] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                >
                  {sending ? <Spinner size={16} /> : allSignersUseCopyLinks ? <Copy size={16} /> : <Send size={16} />}
                  {sending ? primaryActionBusyLabel : primaryActionLabel}
                </button>
              )}
            </div>
          </div>
        }
      >
              {/* Equal columns, and a wider dialog than before: at 1.5fr/1fr in a
                  max-w-3xl shell the right column fell to about 280px, which broke
                  "Choose file destination" onto three lines and its description onto
                  four. */}
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                {/* Signers recap */}
                <div className="rounded-xl border border-outline-subtle bg-surface-alt p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-on-surface">
                      Signers
                      <span className="ml-1.5 font-normal text-on-surface-muted">{signers.length}</span>
                    </p>
                    <button
                      onClick={() => { signersBackTargetsFieldsRef.current = true; setStep('signers'); }}
                      disabled={sending}
                      className="inline-flex items-center gap-0.5 text-xs font-medium text-accent-emphasis hover:underline dark:text-accent-emphasis cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
                    >
                      Edit
                      <ChevronRight size={13} />
                    </button>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-on-surface-muted">
                    {routingMode === 'parallel'
                      ? 'All signers receive the document immediately and can sign independently.'
                      : 'Each signer becomes active only after the previous signer finishes.'}
                  </p>
                  <div className="mt-3 space-y-1.5">
                    {signers.map((signer, index) => {
                      const color = colorForSigner(index);
                      const method = signer.deliveryMethod;
                      const methodLabel = method === 'email' ? 'Email'
                        : method === 'portal' || method === 'internal_dashboard' ? 'Paralegix'
                        : 'Copy link';
                      const fieldCount = signerFieldCounts[signer.participantId] || 0;
                      // Two different things can leave a signer unsendable: nobody
                      // placed a field for them, or their contact details are blank.
                      // Each is called out on its own row; the Edit action above is
                      // the single way back to change signer details or fields.
                      const missingFields = fieldCount === 0;
                      const identityIssue = signerIssues[index];
                      const rowIssueLabel = identityIssue?.rowLabel ?? (missingFields ? 'Add a field' : null);
                      return (
                        <div
                          key={signer.participantId}
                          className={`w-full flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left ${
                            rowIssueLabel
                              ? 'border-red-300 bg-red-50/60 dark:border-red-800 dark:bg-red-900/15'
                              : 'border-outline-subtle bg-surface'
                          }`}
                        >
                          <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${color.badge}`}>{index + 1}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-on-surface">{signerPillLabel(signer, index)}</span>
                            <span className="mt-0.5 flex items-center gap-1.5 text-[11px]">
                              <span className="text-on-surface-muted">{methodLabel}</span>
                              <span className="text-on-surface-muted">&middot;</span>
                              <span className={missingFields ? 'font-semibold text-red-600 dark:text-red-400' : 'text-on-surface-muted'}>
                                {fieldCount} field{fieldCount !== 1 ? 's' : ''}
                              </span>
                            </span>
                          </span>
                          {rowIssueLabel && (
                            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-red-600 dark:text-red-400">
                              <AlertCircle size={13} />
                              {rowIssueLabel}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* What happens once everyone has signed */}
                <div className="rounded-xl border border-outline-subtle bg-surface-alt p-4">
                  <p className="text-sm font-semibold text-on-surface">After signing</p>
                  <p className="mt-1 text-xs leading-relaxed text-on-surface-muted">
                    Where the executed copy goes, and who receives it.
                  </p>

                  <div className="mt-3 space-y-1.5">
                    <button
                      onClick={() => setShowDestinationPicker(true)}
                      className={`w-full flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors cursor-pointer ${
                        destinationPath
                          ? 'border-accent-border-soft bg-accent-soft hover:bg-accent-soft'
                          : 'border-outline-subtle bg-surface hover:bg-surface-hover'
                      }`}
                    >
                      <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                        destinationPath ? 'bg-accent-soft text-accent-emphasis' : 'bg-surface-alt text-on-surface-secondary'
                      }`}>
                        <FolderOpen size={16} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-on-surface">
                          {destinationPath ? destinationLabel : 'Choose file destination'}
                        </span>
                        <span className="block text-[11px] text-on-surface-muted">
                          {destinationPath ? 'The signed PDF is filed here.' : 'Defaults to General Files if left blank.'}
                        </span>
                      </span>
                      {/* The row read as a static summary. A trailing chevron plus
                          "Change"/"Choose" is what marks it as something to press. */}
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-accent-emphasis dark:text-accent-emphasis">
                        {destinationPath ? 'Change' : 'Choose'}
                        <ChevronRight size={13} />
                      </span>
                    </button>

                    <label className="flex w-full cursor-pointer items-start gap-3 rounded-lg border border-outline-subtle bg-surface px-3 py-2.5 transition-colors hover:bg-surface-hover">
                      <Checkbox
                        checked={emailSignersCopy}
                        onChange={setEmailSignersCopy}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-on-surface">Email signers the completed document</span>
                        <span className="block text-[11px] leading-relaxed text-on-surface-muted">
                          Every signer with an email address gets the final PDF once the last signature lands. You receive a copy either way.
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Copy links replace the send action, so they take the full width
                  rather than being squeezed into a column. */}
              {copyLinks.length > 0 && (
                <div className="mt-5 rounded-xl border border-emerald-300 bg-emerald-50/50 p-4 dark:border-emerald-800 dark:bg-emerald-900/15">
                  <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                    Signing links ready
                  </p>
                  <p className="mt-0.5 text-xs text-on-surface-secondary">
                    Copy each link and share it with that signer. Nothing was emailed.
                  </p>
                  <div className="mt-3 space-y-1.5">
                    {copyLinks.map((cl) => (
                      <div key={cl.participantId} className="flex min-w-0 items-center gap-3 rounded-lg border border-outline-subtle bg-surface px-3 py-2">
                        <div className="min-w-0 flex-1 overflow-hidden">
                          <p className="truncate text-xs font-medium text-on-surface">{cl.name}</p>
                          <p className="truncate text-[11px] text-on-surface-muted">{cl.link}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(cl.link);
                            setCopiedLinkId(cl.participantId);
                            setTimeout(() => setCopiedLinkId(null), 2000);
                          }}
                          className="shrink-0 inline-flex items-center gap-1 rounded-md border border-outline bg-surface px-2 py-1 text-xs font-medium text-on-surface-secondary transition-[background-color,transform] hover:bg-surface-hover active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                        >
                          {copiedLinkId === cl.participantId ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
      </Modal>

      <ConfirmModal
        isOpen={confirmDiscard}
        title="Discard this document?"
        message={`You have placed ${state.fields.length} field${state.fields.length !== 1 ? 's' : ''} on ${file.name}. Going back returns you to the upload step and discards them.`}
        confirmText="Discard"
        confirmType="danger"
        onConfirm={() => { setConfirmDiscard(false); leavePlacer(); }}
        onClose={() => setConfirmDiscard(false)}
      />

      <DestinationPickerModal
        lawFirmId={lawFirmId}
        isOpen={showDestinationPicker}
        currentPath={destinationPath}
        onClose={() => setShowDestinationPicker(false)}
        onSelect={(path, label) => {
          setDestinationPath(path);
          setDestinationLabel(label);
          setShowDestinationPicker(false);
        }}
      />

      <Modal
        isOpen={showSaveTemplate}
        onClose={() => setShowSaveTemplate(false)}
        dismissible={!savingTemplate}
        title="Save as Template"
        subtitle="Reuse this signer setup and field layout on future documents."
        size="lg"
        closeIcon={<X size={18} strokeWidth={2} />}
        footer={
          <>
            <button
              onClick={() => setShowSaveTemplate(false)}
              disabled={savingTemplate}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-outline-subtle text-on-surface hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveTemplate}
              disabled={!templateName.trim() || savingTemplate}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover disabled:opacity-50 disabled:cursor-not-allowed transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              {savingTemplate ? <Spinner size={16} /> : <BookmarkPlus size={16} />}
              {savingTemplate ? 'Saving...' : 'Save Template'}
            </button>
          </>
        }
      >
        {/* Save failures set requestError, whose page banners sit underneath
            this overlay; without this the save button fails silently. */}
        {requestError && (
          <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-100 dark:bg-red-950 px-4 py-2.5 text-sm text-red-700 dark:text-red-400">
            {requestError}
          </div>
        )}
        <div>
          <FieldLabel htmlFor={`${fieldIds}-templatename`}>Template Name *</FieldLabel>
          <input
            id={`${fieldIds}-templatename`}
            type="text"
            value={templateName}
            onChange={(event) => setTemplateName(event.target.value)}
            placeholder="Client engagement letter"
            className="w-full rounded-md border border-input-border bg-input-bg text-on-surface px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        </div>
        <div>
          <FieldLabel htmlFor={`${fieldIds}-templatedescription`}>Description</FieldLabel>
          <textarea
            id={`${fieldIds}-templatedescription`}
            value={templateDescription}
            onChange={(event) => setTemplateDescription(event.target.value)}
            placeholder="Notes for this template"
            rows={3}
            className="w-full rounded-md border border-input-border bg-input-bg text-on-surface px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring resize-none"
          />
        </div>
      </Modal>
    </div>
  );
}
