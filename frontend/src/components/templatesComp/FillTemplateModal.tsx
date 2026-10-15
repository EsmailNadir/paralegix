"use client";

import { getMatterLeadNames } from '@/lib/matters/leadNames';

import Tooltip from "@/components/ui/Tooltip";
import { useState, useRef, useEffect, useId, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMountTransition, useResetAfterClose } from "@/hooks/useMountTransition";
import { menuAnim } from "@/components/ui/transitionClasses";
import Modal from "@/components/ui/Modal";
import Toast from "@/components/ui/Toast";
import { Download, X, ChevronDown, BriefcaseBusiness, UserRound, Sparkles, FolderUp, Check, Plus, Trash2, Repeat, Eye, Pencil } from "lucide-react";
import ErrorNotification from "@/components/ErrorNotification";
import EntityPicker from "@/components/ui/EntityPicker";
import { useEntityByIds, type FullLookupItem } from "@/hooks/useEntityLookup";
import mattersService from "@/services/matters.service";
import clientsService from "@/services/clients.service";
import type { Matter, MatterClient, Client, ClientContact } from "@/types";
import type { Template, TemplateFillDraft, TemplateRepeater, TemplateWithHtml } from "@/types/template";
import { templatesService, skippedImagesNotice, incompleteFieldsNotice } from "@/services/templates.service";
import filesService from "@/services/files.service";
import { scopeFromIds } from "@/lib/files/fileScope";
import SaveToFilesModal, { type SaveDestination } from "./SaveToFilesModal";
import { useLawFirm } from "@/contexts/LawFirmContext";
import { injectTemplatePreviewStyles } from "./templatePreview";
import { buildFilledTemplateHtml, buildHydratedFilledTemplateHtml } from "./templateFill";
import { sanitizeRichHtml } from "@/lib/utils/sanitizeHtml";
import Spinner from "@/components/ui/Spinner";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import TextInput from "@/components/ui/TextInput";

type DownloadFormat = "pdf" | "docx" | "odt" | "rtf" | "txt";

/**
 * What a render produced.
 *
 * The stamped path renders on the server and answers with a storage link, so
 * the document does not enter this tab at all unless something needs its
 * bytes. The HTML path renders here, so it holds the bytes and has no link.
 */
type RenderedDocument =
  | { kind: "url"; url: string }
  | { kind: "blob"; blob: Blob };

/**
 * The bytes of a render, reading them back from storage when that is where
 * they are. Only the callers that genuinely need bytes call this: saving to
 * Files uploads them, while previewing and downloading hand the link to the
 * browser and never hold the document.
 */
async function bytesOf(rendered: RenderedDocument): Promise<Blob> {
  if (rendered.kind === "blob") return rendered.blob;
  const res = await fetch(rendered.url);
  if (!res.ok) {
    throw new Error("The filled document could not be read back from storage.");
  }
  return res.blob();
}

const downloadFormats: { value: DownloadFormat; label: string }[] = [
  { value: "pdf", label: "PDF" },
  { value: "docx", label: "Word (DOCX)" },
  { value: "odt", label: "OpenDocument (ODT)" },
  { value: "rtf", label: "Rich Text (RTF)" },
  { value: "txt", label: "Plain Text (TXT)" },
];

interface FillTemplateModalProps {
  open?: boolean;
  template: Template;
  lawFirmId: string;
  onClose: () => void;
  onEdit?: (templateId: string, fillDraft: TemplateFillDraft) => void;
  initialValues?: Record<string, string>;
  initialRepeaterValues?: Record<string, Record<string, string>[]>;
  initialSelectedMatterId?: string;
  initialSelectedClientId?: string;
}

type TemplateValues = Record<string, string>;
type RepeaterRowValues = Record<string, string>;
type TemplateRepeaterValues = Record<string, RepeaterRowValues[]>;
type FieldUsagePreview = {
  label: string;
  matches: Array<{
    pageLabel: string;
    html: string;
  }>;
};

type ResolvedClientSource = {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  organization?: string | null;
  preferredContactMethod?: string | null;
  status?: string | null;
  /** Absent on very old responses; treat as 'person'. Gates the first/last-name split below. */
  clientType?: "person" | "company";
};

function createEmptyValues(fields: string[]): TemplateValues {
  return Object.fromEntries(fields.map((field) => [field, ""]));
}

function createEmptyRepeaterRow(fields: string[], source?: Record<string, string>): RepeaterRowValues {
  return Object.fromEntries(fields.map((field) => [field, source?.[field] ?? ""]));
}

function createEmptyRepeaterValues(repeaters: TemplateRepeater[]): TemplateRepeaterValues {
  return Object.fromEntries(
    repeaters.map((repeater) => [repeater.name, [createEmptyRepeaterRow(repeater.fields)]])
  );
}

function normalizeInitialValues(
  fields: string[],
  initialValues?: Record<string, string>,
): TemplateValues {
  const defaults = createEmptyValues(fields);
  if (!initialValues) return defaults;

  for (const field of fields) {
    defaults[field] = initialValues[field] ?? "";
  }

  return defaults;
}

function normalizeInitialRepeaterValues(
  repeaters: TemplateRepeater[],
  initialRepeaterValues?: Record<string, Record<string, string>[]>,
): TemplateRepeaterValues {
  const defaults = createEmptyRepeaterValues(repeaters);
  if (!initialRepeaterValues) return defaults;

  for (const repeater of repeaters) {
    const restoredRows = initialRepeaterValues[repeater.name];
    if (!restoredRows || restoredRows.length === 0) continue;
    defaults[repeater.name] = restoredRows.map((row) =>
      createEmptyRepeaterRow(repeater.fields, row)
    );
  }

  return defaults;
}

function sanitizePreviewClone(node: HTMLElement) {
  node.removeAttribute("contenteditable");
  node.removeAttribute("data-placeholder-chip-selected");

  node.querySelectorAll<HTMLElement>("[data-chip-remove]").forEach((removeButton) => removeButton.remove());
  node.querySelectorAll<HTMLElement>("[contenteditable]").forEach((editable) => editable.removeAttribute("contenteditable"));

  const resetPositioning = (element: HTMLElement) => {
    element.style.position = "static";
    element.style.left = "auto";
    element.style.top = "auto";
    element.style.right = "auto";
    element.style.bottom = "auto";
    element.style.width = "auto";
    element.style.maxWidth = "100%";
    element.style.minHeight = "0";
    element.style.margin = "0";
  };

  resetPositioning(node);
  node.style.display = "block";
  node.style.whiteSpace = "normal";
  node.style.padding = "0";
  node.style.color = "#111827";
  node.style.background = "transparent";

  node.querySelectorAll<HTMLElement>("*").forEach((element) => {
    resetPositioning(element);
    if (!element.style.color) {
      element.style.color = "#111827";
    }
  });
}

function buildFieldUsagePreview(
  templateHtml: string,
  fieldName: string,
  label: string
): FieldUsagePreview {
  const parser = new DOMParser();
  const doc = parser.parseFromString(templateHtml, "text/html");
  const pages = Array.from(doc.querySelectorAll<HTMLElement>(".pdf-page"));
  const chips = Array.from(doc.querySelectorAll<HTMLElement>("[data-placeholder-chip]")).filter(
    (chip) => (chip.getAttribute("data-placeholder-chip") ?? "") === fieldName
  );

  const seen = new Set<string>();
  const matches = chips.flatMap((chip) => {
    const paragraph = chip.closest<HTMLElement>(".pdf-page > p");
    const textBoxEditor = chip.closest<HTMLElement>("[data-template-text-box-editor]");
    const source = paragraph ?? textBoxEditor;
    if (!source) return [];

    const key = source.getAttribute("data-logical-paragraph-id")
      ?? source.getAttribute("data-template-text-box-id")
      ?? `${fieldName}-${source.textContent}`;

    if (seen.has(key)) return [];
    seen.add(key);

    const clone = source.cloneNode(true) as HTMLElement;
    sanitizePreviewClone(clone);

    clone.querySelectorAll<HTMLElement>("[data-placeholder-chip]").forEach((candidate) => {
      const candidateName = candidate.getAttribute("data-placeholder-chip") ?? "";
      if (candidateName === fieldName) {
        candidate.style.background = "rgba(59, 130, 246, 0.16)";
        candidate.style.outline = "1px solid rgba(59, 130, 246, 0.45)";
        candidate.style.borderRadius = "6px";
        candidate.style.padding = "0 4px";
      } else {
        candidate.style.opacity = "0.75";
      }
    });

    const parentPage = source.closest<HTMLElement>(".pdf-page");
    const pageIndex = parentPage ? pages.indexOf(parentPage) : -1;

    return [{
      pageLabel: pageIndex >= 0 ? `Page ${pageIndex + 1}` : "Template",
      html: clone.outerHTML,
    }];
  });

  return { label, matches };
}

function normalizeFieldKey(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Normalize a template placeholder id (or an auto-fill alias) to a comparable
 * key. Same rules as normalizeFieldKey plus a camelCase/PascalCase split, so a
 * placeholder written `clientName` or `ClientName` matches the `client_name`
 * alias instead of collapsing to an unmatchable `clientname`.
 *
 * Kept separate from normalizeFieldKey because that one also keys people's
 * names for matching; splitting on internal capitals there would stop
 * "McDonald" matching "Mcdonald".
 */
function normalizePlaceholderKey(value: string): string {
  const split = value
    // Acronym followed by a word: "PDFName" -> "PDF_Name".
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    // Ordinary camelCase boundary: "clientName" -> "client_Name".
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return normalizeFieldKey(split);
}

function toDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value instanceof Date) return value.toLocaleDateString();
  if (Array.isArray(value)) {
    return value.map((item) => toDisplayValue(item)).filter(Boolean).join(", ");
  }
  return String(value);
}

function setAliases(target: Record<string, string>, aliases: string[], value: unknown) {
  const displayValue = toDisplayValue(value);
  if (!displayValue) return;

  for (const alias of aliases) {
    const normalizedAlias = normalizePlaceholderKey(alias);
    if (!normalizedAlias || target[normalizedAlias]) continue;
    target[normalizedAlias] = displayValue;
  }
}

function splitName(name?: string | null) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

function findMatchingMatterClient(client: Client | null, matterClients: MatterClient[]): MatterClient | null {
  if (!client) return null;

  const clientNameKey = normalizeFieldKey(client.name ?? "");
  return (
    matterClients.find((matterClient) => {
      const candidateUserId = matterClient.userId?.trim();
      return Boolean(
        (candidateUserId && (candidateUserId === client.id || candidateUserId === client.userId))
        || matterClient.id === client.id
        || (clientNameKey && normalizeFieldKey(matterClient.name) === clientNameKey)
      );
    }) ?? null
  );
}

function resolveClientSource(client: Client | null, matterClient: MatterClient | null): ResolvedClientSource | null {
  if (!client && !matterClient) return null;

  return {
    id: client?.id ?? matterClient?.id ?? "",
    name: matterClient?.name || client?.name || "Unnamed Client",
    email: matterClient?.email ?? client?.email,
    phone: matterClient?.phone ?? client?.phone,
    address: matterClient?.address ?? client?.address,
    organization: matterClient?.organization ?? client?.organization,
    preferredContactMethod: matterClient?.preferredContactMethod ?? client?.preferredContactMethod,
    status: client?.status,
    clientType: client?.clientType ?? matterClient?.clientType,
  };
}

function buildMatterValueMap(matterItem: Matter | null) {
  const map: Record<string, string> = {};
  if (!matterItem) return map;

  setAliases(map, ["case", "case_name", "case_title", "matter", "matter_name"], matterItem.name);
  setAliases(map, ["case_number", "case_no", "case_num", "matter_number", "file_number", "file_no", "docket_number"], matterItem.matterNumber);
  setAliases(map, ["case_reference_id", "reference_id", "matter_reference_id"], matterItem.matterReferenceId);
  setAliases(map, ["case_description"], matterItem.description);
  setAliases(map, ["case_status"], matterItem.status);
  setAliases(map, ["practice_area", "practice_area_name"], matterItem.practiceAreaName);
  setAliases(map, ["case_category", "category"], matterItem.category);
  const leadValue = getMatterLeadNames(matterItem).join(', ');
  setAliases(map, ["lead_attorney", "lead_user_name", "lead_lawyer", "attorney_name"], leadValue);

  return map;
}

function buildClientValueMap(client: ResolvedClientSource | null) {
  const map: Record<string, string> = {};
  if (!client) return map;

  // A company has no single person's name to split. Leaving these unset (rather
  // than splitting "Acme Manufacturing LLC" into a first/last name) means a
  // template using {{first_name}} renders blank for a company client instead of
  // a plausible-looking wrong greeting like "Dear Acme," - a clear signal to the
  // template author to use the company-specific tokens instead.
  if (client.clientType !== "company") {
    const { firstName, lastName } = splitName(client.name);
    setAliases(map, ["client_first_name", "first_name"], firstName);
    setAliases(map, ["client_last_name", "last_name", "surname"], lastName);
  }

  setAliases(map, ["client", "client_name", "name", "full_name"], client.name);
  setAliases(map, ["client_email", "email", "email_address"], client.email);
  setAliases(map, ["client_phone", "phone", "phone_number", "telephone", "mobile", "mobile_phone"], client.phone);
  setAliases(map, ["client_address", "client_location", "address", "street_address", "mailing_address"], client.address);
  setAliases(map, ["client_organization", "organization", "company", "company_name"], client.organization);
  setAliases(map, ["client_preferred_contact_method", "preferred_contact_method", "contact_method"], client.preferredContactMethod);
  setAliases(map, ["client_status"], client.status);

  return map;
}

/**
 * Primary-contact and billing-contact tokens for a COMPANY client, sourced from
 * its roster of linked Person clients (`client_company_links`). Meaningless
 * for a person client, so the caller only passes contacts when `clientType
 * === 'company'`; both arguments are null otherwise and every alias here is
 * left unset. There is no title token: a roster entry is a real Person
 * client now, and a Person client has no `title` field.
 */
function buildCompanyContactValueMap(
  primaryContact: ClientContact | null,
  billingContact: ClientContact | null,
) {
  const map: Record<string, string> = {};

  if (primaryContact) {
    setAliases(map, ["company_primary_contact_name", "primary_contact_name"], primaryContact.name);
  }

  if (billingContact) {
    setAliases(map, ["company_billing_contact_name", "billing_contact_name"], billingContact.name);
    setAliases(map, ["company_billing_contact_email", "billing_contact_email"], billingContact.email);
  }

  return map;
}

/**
 * The roster contact that would receive billing communications first, mirroring
 * the ordering `resolveCurrentBillingRecipients`/`fetchCompanyBillingContacts`
 * use server-side (backend `billingRecipientSnapshot.service.ts`): primary
 * status, then creation time, then id, preferring the first candidate with a
 * usable email. Kept in lockstep with that ordering so the merge-field token
 * names the same contact an actual invoice would attention to.
 */
function pickBillingContact(contacts: ClientContact[]): ClientContact | null {
  const billingContacts = contacts
    .filter((contact) => contact.isEmailRecipient)
    .slice()
    .sort((a, b) => {
      if (Boolean(a.isPrimary) !== Boolean(b.isPrimary)) return a.isPrimary ? -1 : 1;
      const aCreated = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bCreated = b.createdAt ? Date.parse(b.createdAt) : 0;
      if (aCreated !== bCreated) return aCreated - bCreated;
      return (a.id || "").localeCompare(b.id || "");
    });

  if (billingContacts.length === 0) return null;
  return billingContacts.find((contact) => (contact.email || "").trim()) || billingContacts[0];
}

function buildDateValueMap() {
  const map: Record<string, string> = {};
  const now = new Date();

  setAliases(map, ["today", "current_date", "date", "todays_date", "document_date"], now.toLocaleDateString());
  setAliases(map, ["full_date", "long_date", "date_long"], now.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }));
  setAliases(map, ["year", "current_year"], String(now.getFullYear()));
  setAliases(map, ["month", "current_month"], now.toLocaleDateString(undefined, { month: "long" }));
  setAliases(map, ["day", "current_day", "day_of_month"], String(now.getDate()));

  return map;
}

function buildFirmValueMap(lawFirm: { name?: string; address?: string; city?: string; state?: string; zip?: string; phone?: string; email?: string } | null) {
  const map: Record<string, string> = {};
  if (!lawFirm) return map;

  setAliases(map, ["firm", "firm_name", "law_firm", "law_firm_name"], lawFirm.name);
  setAliases(map, ["firm_address", "law_firm_address", "office_address"], lawFirm.address);
  setAliases(map, ["firm_city", "law_firm_city"], lawFirm.city);
  setAliases(map, ["firm_state", "law_firm_state"], lawFirm.state);
  setAliases(map, ["firm_zip", "law_firm_zip", "firm_postal_code"], lawFirm.zip);
  setAliases(map, ["firm_phone", "law_firm_phone", "office_phone"], lawFirm.phone);
  setAliases(map, ["firm_email", "law_firm_email", "office_email"], lawFirm.email);

  const fullAddress = [lawFirm.address, lawFirm.city, lawFirm.state, lawFirm.zip].filter(Boolean).join(", ");
  setAliases(map, ["firm_full_address", "law_firm_full_address"], fullAddress || null);

  return map;
}

export default function FillTemplateModal({
  open = true,
  template,
  lawFirmId,
  onClose,
  onEdit,
  initialValues,
  initialRepeaterValues,
  initialSelectedMatterId,
  initialSelectedClientId,
}: FillTemplateModalProps) {
  const titleId = useId();
  const repeaters: TemplateRepeater[] = useMemo(() => template.repeaters ?? [], [template.repeaters]);
  const repeaterFieldSet = useMemo(() => {
    const set = new Set<string>();
    for (const r of repeaters) {
      for (const f of r.fields) set.add(`${r.name}.${f}`);
    }
    return set;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.repeaters]);
  const regularFields = useMemo(
    () => template.fields.filter((f) => !repeaterFieldSet.has(f)),
    [template.fields, repeaterFieldSet]
  );

  const normalizedInitialValues = useMemo(
    () => normalizeInitialValues(regularFields, initialValues),
    [regularFields, initialValues]
  );
  const normalizedInitialRepeaterValues = useMemo(
    () => normalizeInitialRepeaterValues(repeaters, initialRepeaterValues),
    [repeaters, initialRepeaterValues]
  );
  const restoredRegularFieldKeys = useMemo(
    () => new Set(Object.keys(normalizedInitialValues).filter((key) => normalizedInitialValues[key] !== "")),
    [normalizedInitialValues]
  );
  const [values, setValues] = useState<TemplateValues>(normalizedInitialValues);
  const [repeaterValues, setRepeaterValues] = useState<TemplateRepeaterValues>(normalizedInitialRepeaterValues);
  const [exporting, setExporting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  /**
   * The save to Files in flight. Dismissing the destination picker, or this
   * dialog unmounting, aborts it so nothing is filed from a save the user
   * walked away from.
   */
  const saveAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    saveAbortRef.current?.abort();
    saveAbortRef.current = null;
  }, []);
  const [error, setError] = useState<string | null>(null);
  useResetAfterClose(open, () => setError(null));
  // Outlives the dialog: a download closes it, and this is the one thing the
  // person still needs to hear about that document (an image left out, or text
  // that did not print). Not reset on close for that reason.
  const [renderNotice, setRenderNotice] = useState<string | null>(null);
  // The panel's own open/close animation is now Modal's job, so nothing else
  // in this component unmounts when the dialog closes: the save-to-files
  // sub-dialog must be dismissed explicitly, or it would linger with no
  // dialog behind it.
  useResetAfterClose(open, () => setShowSaveModal(false));
  const [showFormats, setShowFormats] = useState(false);
  const { mounted: formatsMounted, exiting: formatsExiting } = useMountTransition(showFormats, 150);
  const [fieldUsagePreviewTarget, setFieldUsagePreviewTarget] = useState<{ name: string; label: string } | null>(null);
  // Same reasoning as the save-to-files reset above: this popover floats above
  // the panel independently of Modal's own lifecycle, so it needs its own
  // explicit dismissal when the dialog closes.
  useResetAfterClose(open, () => setFieldUsagePreviewTarget(null));
  const [selectedMatterId, setSelectedMatterIdRaw] = useState(initialSelectedMatterId ?? "");
  const [selectedClientId, setSelectedClientIdRaw] = useState(initialSelectedClientId ?? "");
  // The enriched matter the picker last handed back, so the merge-field map has
  // the whole record without waiting on a second round trip.
  const [pickedMatter, setPickedMatter] = useState<FullLookupItem | null>(null);
  const [pickedClient, setPickedClient] = useState<FullLookupItem | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const fieldUsageTitleId = useId();
  // Retain the last target so the overlay keeps its label during the exit animation.
  const fieldUsageRetainedRef = useRef(fieldUsagePreviewTarget);
  if (fieldUsagePreviewTarget) fieldUsageRetainedRef.current = fieldUsagePreviewTarget;
  const fieldUsageDisplayTarget = fieldUsagePreviewTarget ?? fieldUsageRetainedRef.current;
  const [manuallyEdited, setManuallyEdited] = useState<Set<string>>(() => new Set(restoredRegularFieldKeys));
  // Fields that were restored from a previous fill session, protected from auto-fill
  // until the user explicitly picks a new matter/client (which clears this ref).
  const restoredFieldsRef = useRef<Set<string>>(new Set(restoredRegularFieldKeys));

  const setSelectedMatterId = (id: string) => {
    setSelectedMatterIdRaw(id);
    if (!id) setPickedMatter(null);
    setManuallyEdited(new Set());
    restoredFieldsRef.current = new Set();
  };
  const setSelectedClientId = (id: string) => {
    setSelectedClientIdRaw(id);
    if (!id) setPickedClient(null);
    setManuallyEdited(new Set());
    restoredFieldsRef.current = new Set();
  };

  const { lawFirm } = useLawFirm();
  const { data: matterClients = [], isLoading: loadingMatterClients } = useQuery<MatterClient[]>({
    queryKey: ["template-fill-matter-clients", lawFirmId, selectedMatterId],
    queryFn: () => mattersService.listClients(lawFirmId, selectedMatterId),
    enabled: open && !!lawFirmId && !!selectedMatterId,
    staleTime: 60_000,
  });
  const { data: fullTemplate } = useQuery<TemplateWithHtml>({
    queryKey: ["template-fill-detail", lawFirmId, template.id],
    queryFn: () => templatesService.getById(lawFirmId, template.id),
    enabled: open && !!lawFirmId && !!template.id,
    staleTime: 60_000,
  });

  // The picker hands back the complete matter on selection; the id lookup covers
  // the other entry point, where the modal opens with a matter id from props and
  // nothing was ever picked. Both ask for `full`, so they share one cache entry.
  const { items: selectedMatterItems } = useEntityByIds<FullLookupItem>(
    "matters",
    lawFirmId,
    selectedMatterId ? [selectedMatterId] : [],
    { full: true }
  );

  const selectedMatter = useMemo(() => {
    if (pickedMatter && pickedMatter.id === selectedMatterId) {
      return pickedMatter as unknown as Matter;
    }
    const resolved = selectedMatterItems.find((item) => item.id === selectedMatterId);
    return resolved ? (resolved as unknown as Matter) : null;
  }, [pickedMatter, selectedMatterItems, selectedMatterId]);

  /**
   * Scope the client picker to the matter's own clients, but only once we know
   * the matter has some. Narrowing a matter with no linked clients would leave
   * the picker empty with no way to fill a client at all, so that case falls back
   * to the whole roster, exactly as the previous "related clients or everyone"
   * option list did. While the matter's clients are still loading the scope stays
   * on, so the picker never briefly offers the firm's entire roster.
   */
  const clientScopeMatterId =
    selectedMatterId && (loadingMatterClients || matterClients.length > 0) ? selectedMatterId : undefined;

  // Same two-source resolution as the matter above: the picker's own item first,
  // then an id lookup for a client id that arrived from props.
  const { items: selectedClientItems } = useEntityByIds<FullLookupItem>(
    "clients",
    lawFirmId,
    selectedClientId ? [selectedClientId] : [],
    { matterId: clientScopeMatterId, full: true }
  );

  const selectedClient = useMemo(() => {
    if (pickedClient && pickedClient.id === selectedClientId) {
      return pickedClient as unknown as Client;
    }
    const resolved = selectedClientItems.find((item) => item.id === selectedClientId);
    return resolved ? (resolved as unknown as Client) : null;
  }, [pickedClient, selectedClientItems, selectedClientId]);

  const matchedMatterClient = useMemo(
    () => findMatchingMatterClient(selectedClient, matterClients),
    [selectedClient, matterClients]
  );

  const fallbackMatterClient = useMemo(
    () => (!selectedClient && matterClients.length === 1 ? matterClients[0] : null),
    [selectedClient, matterClients]
  );

  const resolvedClient = useMemo(
    () => resolveClientSource(selectedClient, matchedMatterClient ?? fallbackMatterClient),
    [selectedClient, matchedMatterClient, fallbackMatterClient]
  );

  // The primary/billing-contact tokens are a company-only, roster-scoped
  // concept, so the roster is only ever fetched for a company client - never
  // for a person, who has no `contact_clients` roster to read.
  const companyClientId = resolvedClient?.clientType === "company" ? resolvedClient.id : undefined;
  const { data: companyContacts = [] } = useQuery<ClientContact[]>({
    queryKey: ["template-fill-client-contacts", lawFirmId, companyClientId],
    queryFn: () => clientsService.listClientContacts(lawFirmId, companyClientId!),
    enabled: open && !!lawFirmId && !!companyClientId,
    staleTime: 60_000,
  });

  const primaryContact = useMemo(
    () => companyContacts.find((contact) => contact.isPrimary) ?? null,
    [companyContacts]
  );
  const billingContact = useMemo(() => pickBillingContact(companyContacts), [companyContacts]);

  const { autoFillValues, repeaterAutoFill } = useMemo(() => {
    const matterValues = buildMatterValueMap(selectedMatter);
    const clientValues = buildClientValueMap(resolvedClient);
    const companyContactValues = buildCompanyContactValueMap(primaryContact, billingContact);
    const firmValues = buildFirmValueMap(lawFirm);
    const dateValues = buildDateValueMap();

    const lookup = (key: string) => {
      const n = normalizePlaceholderKey(key);
      return clientValues[n] || companyContactValues[n] || matterValues[n] || firmValues[n] || dateValues[n] || "";
    };

    const af = Object.fromEntries(
      regularFields.map((field) => [field, lookup(field)])
    ) as TemplateValues;

    // Build autofill map for repeater sub-fields (e.g. "date" inside "payments")
    const rAf: Record<string, Record<string, string>> = {};
    for (const r of repeaters) {
      const subMap: Record<string, string> = {};
      for (const f of r.fields) {
        const val = lookup(f);
        if (val) subMap[f] = val;
      }
      if (Object.keys(subMap).length > 0) rAf[r.name] = subMap;
    }

    return { autoFillValues: af, repeaterAutoFill: rAf };
  }, [regularFields, repeaters, selectedMatter, resolvedClient, primaryContact, billingContact, lawFirm]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initializes the user-editable form values from the incoming template/initial-value props
    setValues(normalizedInitialValues);
    setRepeaterValues(normalizedInitialRepeaterValues);
    setSelectedMatterIdRaw(initialSelectedMatterId ?? "");
    setSelectedClientIdRaw(initialSelectedClientId ?? "");
    setManuallyEdited(new Set(restoredRegularFieldKeys));
    restoredFieldsRef.current = new Set(restoredRegularFieldKeys);
  }, [
    template.id,
    normalizedInitialValues,
    normalizedInitialRepeaterValues,
    initialSelectedMatterId,
    initialSelectedClientId,
    restoredRegularFieldKeys,
  ]);

  useEffect(() => {
    if (!showFormats) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowFormats(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showFormats]);

  useEffect(() => {
    if (!selectedMatterId) return;
    if (loadingMatterClients) return;
    // A matter with no clients of its own leaves the picker unscoped, so there is
    // nothing to reconcile the selection against and clearing it would fight the user.
    if (matterClients.length === 0) return;

    const currentClientOnMatter = matterClients.some((client) => client.id === selectedClientId);
    if (selectedClientId && currentClientOnMatter) return;

    if (!selectedClientId && matterClients.length !== 1) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-selects the matter's only client once its clients finish loading; selection remains user-editable
    setSelectedClientId(matterClients.length === 1 ? matterClients[0].id : "");
  }, [selectedMatterId, selectedClientId, matterClients, loadingMatterClients]);

  useEffect(() => {
    setValues((currentValues) => {
      const nextValues = { ...currentValues };
      let changed = false;

      for (const field of regularFields) {
        if (manuallyEdited.has(field)) continue;
        if (restoredFieldsRef.current.has(field)) continue;
        const nextAutoValue = autoFillValues[field] ?? "";
        // Only overwrite with real auto-fill data. Fields with no auto-fill alias
        // resolve to "", and blanking them here would erase hand-typed values
        // whenever a matter/client selection clears the manually-edited set.
        if (!nextAutoValue) continue;
        if (currentValues[field] !== nextAutoValue) {
          nextValues[field] = nextAutoValue;
          changed = true;
        }
      }

      return changed ? nextValues : currentValues;
    });
  }, [autoFillValues, regularFields, manuallyEdited]);

  // Auto-fill repeater sub-fields (e.g. "date" in a row gets today's date)
  useEffect(() => {
    if (Object.keys(repeaterAutoFill).length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- merges derived auto-fill values into user-editable repeater rows without overwriting filled cells
    setRepeaterValues((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [rName, subMap] of Object.entries(repeaterAutoFill)) {
        const rows = next[rName];
        if (!rows) continue;
        const updatedRows = rows.map((row) => {
          const updatedRow = { ...row };
          let rowChanged = false;
          for (const [f, val] of Object.entries(subMap)) {
            if (!updatedRow[f]) {
              updatedRow[f] = val;
              rowChanged = true;
            }
          }
          if (rowChanged) changed = true;
          return rowChanged ? updatedRow : row;
        });
        if (changed) next[rName] = updatedRows;
      }
      return changed ? next : prev;
    });
  }, [repeaterAutoFill]);

  // Built from the retained target, so the overlay keeps showing the matching
  // lines while it animates out after the live target has been cleared.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- manual memoization is intentional
  const fieldUsagePreview = useMemo(() => {
    if (!fieldUsageDisplayTarget || !fullTemplate?.html) return null;
    return buildFieldUsagePreview(
      fullTemplate.html,
      fieldUsageDisplayTarget.name,
      fieldUsageDisplayTarget.label
    );
  }, [fieldUsageDisplayTarget, fullTemplate?.html]);

  const isDocx = template.type === "docx";
  // Overlay templates have no HTML at all (the layout is placement boxes on
  // top of the original PDF), so they always fill through the same
  // server-side stamping endpoint DOCX uses instead of the client-side HTML
  // render path below. `fillDocxTemplate` is named for its original caller;
  // the `/fill` route itself already branches on `templates.type` server-side
  // and handles overlay transparently (see backend `templates.service.ts`).
  const isStamped = isDocx || template.type === "overlay";

  const getResolvedTemplate = async () => {
    return fullTemplate ?? await templatesService.getById(lawFirmId, template.id);
  };

  /**
   * The PDF for a template that has HTML. This tab fills the HTML; the server
   * renders it, with the template's own stored images.
   */
  const renderHtmlPdfBlob = async (): Promise<Blob> => {
    const full = await getResolvedTemplate();
    const filledHtml = buildFilledTemplateHtml(full.html!, values, repeaterValues);
    const { blob, skippedImages } = await templatesService.renderPdf(
      lawFirmId, template.id, filledHtml, { fileName: template.name },
    );
    setRenderNotice(skippedImages > 0 ? skippedImagesNotice(skippedImages) : null);
    return blob;
  };

  /**
   * The filled document, however this template produces one.
   *
   * `disposition` reaches only the stamped path, which is the one that answers
   * with a link. Preview asks for `inline`, because a link that carries
   * `attachment` downloads the file instead of showing it in the tab opened
   * for it.
   */
  const renderDocument = async (
    format: DownloadFormat,
    disposition: "inline" | "attachment"
  ): Promise<RenderedDocument> => {
    const full = await getResolvedTemplate();
    const usesEditableHtml = Boolean(full.html);

    if (isStamped && !usesEditableHtml) {
      const link = await templatesService.fillDocxTemplate(
        lawFirmId,
        template.id,
        values,
        repeaterValues,
        format,
        undefined,
        disposition
      );
      const incomplete = link.incompleteFields ?? [];
      setRenderNotice(incomplete.length > 0 ? incompleteFieldsNotice(incomplete) : null);
      return { kind: "url", url: link.url };
    }

    if (format === "pdf") return { kind: "blob", blob: await renderHtmlPdfBlob() };

    // HTML templates: render the PDF here, then convert it through the
    // authenticated service (the convert route requires a Firebase token).
    const pdfBlob = await renderHtmlPdfBlob();
    const pdfFile = new File([pdfBlob], "document.pdf", { type: "application/pdf" });
    return { kind: "blob", blob: await templatesService.convertToFormat(pdfFile, format) };
  };

  const generateFilledTemplatePreviewHtml = async (): Promise<string | null> => {
    const full = await getResolvedTemplate();
    if (!full.html) return null;
    const assetPreviewUrls = Object.fromEntries(
      (full.assets ?? [])
        .filter((asset) => Boolean(asset.previewUrl))
        .map((asset) => [asset.id, asset.previewUrl as string])
    );
    const filledHtml = await buildHydratedFilledTemplateHtml(full.html, values, repeaterValues, assetPreviewUrls);
    return injectTemplatePreviewStyles(filledHtml, `${template.name} Preview`);
  };

  const hasEmptyRegularFields = regularFields.length > 0 && regularFields.some((field) => !values[field]?.trim());
  const hasEmptyRepeaterFields = repeaters.some((r) =>
    (repeaterValues[r.name] ?? []).some((row) =>
      r.fields.some((f) => !row[f]?.trim())
    )
  );
  const hasEmptyFields = hasEmptyRegularFields || hasEmptyRepeaterFields;

  const getMissingFields = () => {
    const emptyRegular = regularFields.filter((field) => !values[field]?.trim());
    const emptyRepeater = repeaters.flatMap((r) =>
      (repeaterValues[r.name] ?? []).flatMap((row, i) =>
        r.fields.filter((f) => !row[f]?.trim()).map((f) => `${r.name}[${i + 1}].${f}`)
      )
    );

    return [...emptyRegular, ...emptyRepeater];
  };

  const ensureAllFieldsFilled = (action: "previewing" | "downloading" | "saving") => {
    if (!hasEmptyFields) return true;

    setError(`Please fill in all fields before ${action}: ${getMissingFields().join(", ")}`);
    return false;
  };

  const handlePreview = async () => {
    if (!ensureAllFieldsFilled("previewing")) return;

    const previewWindow = window.open("", "_blank");
    if (!previewWindow) {
      setError("Preview was blocked. Please allow pop-ups and try again.");
      return;
    }

    previewWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Opening preview...</title>
          <style>
            body {
              margin: 0;
              min-height: 100vh;
              display: grid;
              place-items: center;
              background: #111827;
              color: #f9fafb;
              font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
          </style>
        </head>
        <body>Preparing your preview...</body>
      </html>
    `);
    previewWindow.document.close();

    setPreviewing(true);
    setError(null);

    try {
      const full = await getResolvedTemplate();
      const usesEditableHtml = Boolean(full.html);

      if (isStamped && !usesEditableHtml) {
        // DOCX/overlay templates: the server fills the document and answers
        // with an inline link, so the tab shows it from storage and this one
        // never holds it.
        const rendered = await renderDocument("pdf", "inline");
        previewWindow.location.href = rendered.kind === "url"
          ? rendered.url
          : URL.createObjectURL(rendered.blob);
      } else {
        const previewHtml = await generateFilledTemplatePreviewHtml();
        const previewBlob = new Blob([previewHtml!], { type: "text/html" });
        const previewUrl = URL.createObjectURL(previewBlob);
        previewWindow.location.href = previewUrl;
        window.setTimeout(() => URL.revokeObjectURL(previewUrl), 60_000);
      }
    } catch (err) {
      previewWindow.close();
      setError(getErrorMessage(err, "Failed to open preview."));
    } finally {
      setPreviewing(false);
    }
  };

  const handleDownload = async (format: DownloadFormat = "pdf") => {
    if (!ensureAllFieldsFilled("downloading")) return;
    setExporting(true);
    setError(null);
    try {
      const rendered = await renderDocument(format, "attachment");

      // A storage link is given to the browser as it is. Building a Blob from
      // it first would pull the whole document into the tab to save a file the
      // browser can save on its own.
      const url = rendered.kind === "url"
        ? rendered.url
        : URL.createObjectURL(rendered.blob);
      const a = document.createElement("a");
      a.href = url;
      // A hint only for a same-origin blob. Storage sets the real filename in
      // the Content-Disposition the signed link carries.
      a.download = `${template.name}.${format}`;
      a.rel = "noopener noreferrer";
      a.click();
      if (rendered.kind === "blob") URL.revokeObjectURL(url);

      onClose();
    } catch (err) {
      setError(getErrorMessage(err, "Failed to download."));
    } finally {
      setExporting(false);
    }
  };

  const handleOpenSaveModal = () => {
    if (!ensureAllFieldsFilled("saving")) return;
    setError(null);
    setShowSaveModal(true);
  };

  /** Dismissing the destination picker mid-save stops the save: nothing is filed. */
  const closeSaveModal = () => {
    saveAbortRef.current?.abort();
    saveAbortRef.current = null;
    setShowSaveModal(false);
  };

  const handleConfirmSave = async (destination: SaveDestination) => {
    const controller = new AbortController();
    saveAbortRef.current = controller;
    const { signal } = controller;
    setUploading(true);
    setError(null);
    try {
      // The one caller that genuinely needs bytes: the upload sends them. For a
      // stamped template they are read back from storage rather than from the
      // fill response, which is one copy fewer through the API instance.
      const pdfBlob = await bytesOf(await renderDocument("pdf", "attachment"));
      // The render cannot be stopped part way, so a cancel that arrived during
      // it is honoured here, before anything is sent.
      if (signal.aborted) return;
      const file = new File([pdfBlob], destination.fileName, { type: "application/pdf" });

      await filesService.upload(
        lawFirmId,
        scopeFromIds({
          matterId: destination.scope === "matter" ? destination.matterId : null,
          taskId: destination.scope === "task" ? destination.taskId : null,
          clientId: destination.scope === "client" ? destination.clientId : null,
        }),
        [file],
        undefined,
        destination.folderId,
        signal
      );

      setShowSaveModal(false);
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        onClose();
      }, 1200);
    } catch (err) {
      // Cancelled by the user, which is neither a save nor a failure.
      if (signal.aborted) return;
      setError(getErrorMessage(err, "Failed to save to files."));
    } finally {
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
      setUploading(false);
    }
  };

  return (
    <>
    <Modal
      isOpen={open}
      onClose={onClose}
      showClose={false}
      labelledBy={titleId}
      size="lg"
      className="border border-outline"
      bodyClassName={null}
    >
          <div className="flex items-center justify-between px-6 py-4 border-b border-outline shrink-0">
            <div>
              <h2 id={titleId} className="text-base font-semibold text-on-surface">{template.name}</h2>
              <p className="text-xs text-on-surface-muted mt-0.5">Fill in the fields below to generate the document</p>
            </div>
            <div className="flex items-center gap-2">
              {onEdit && (
                <Tooltip title="Edit template" enterDelay={300}>
                  <button aria-label="Edit template"
                    onClick={() =>
                      onEdit(template.id, {
                        values,
                        repeaterValues,
                        selectedMatterId,
                        selectedClientId,
                      })
                    }
                    disabled={exporting || uploading || previewing}
                    className="flex items-center justify-center w-8 h-8 rounded-md border border-input-border bg-surface text-on-surface-muted hover:text-on-surface hover:bg-surface-hover disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                  >
                    <Pencil size={14} />
                  </button>
                </Tooltip>
              )}
              <Tooltip title="Preview filled document" enterDelay={300}>
                <button aria-label="Preview filled document"
                  onClick={handlePreview}
                  disabled={previewing || exporting || uploading}
                  className="flex items-center justify-center w-8 h-8 rounded-md border border-input-border bg-surface text-on-surface-muted hover:text-on-surface hover:bg-surface-hover disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                >
                  {previewing ? <Spinner /> : <Eye size={14} />}
                </button>
              </Tooltip>
              <button onClick={onClose} className="flex items-center justify-center w-8 h-8 text-on-surface-muted hover:text-on-surface cursor-pointer">
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="px-6 py-5 space-y-4 overflow-y-scroll styled-scrollbar">
            <ErrorNotification error={error} onClose={() => setError(null)} />

            <div className="rounded-lg border border-outline bg-surface-alt p-4 space-y-4">
              <div className="flex items-start gap-2">
                <div className="mt-0.5 rounded-md bg-blue-50 px-2 py-1 text-accent-emphasis dark:bg-blue-950/40 dark:text-blue-300">
                  <Sparkles size={14} />
                </div>
                <div>
                  <p className="text-sm font-medium text-on-surface">Auto-fill from a matter or client</p>
                  <p className="text-xs text-on-surface-muted mt-0.5">
                    Pick a matter, client, or both to prefill matching placeholder IDs like <span className="font-mono">client_name</span>, <span className="font-mono">case_number</span>, and more. Firm info and dates are filled automatically.
                  </p>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <EntityPicker<FullLookupItem>
                  entity="matters"
                  lawFirmId={lawFirmId}
                  full
                  label="Matter"
                  value={selectedMatterId}
                  onChange={setSelectedMatterId}
                  onSelectItem={setPickedMatter}
                  placeholder="Search matters"
                  icon={<BriefcaseBusiness size={15} />}
                  portal
                />

                <div>
                  <EntityPicker<FullLookupItem>
                    entity="clients"
                    lawFirmId={lawFirmId}
                    full
                    matterId={clientScopeMatterId}
                    label="Client"
                    value={selectedClientId}
                    onChange={setSelectedClientId}
                    onSelectItem={setPickedClient}
                    placeholder={
                      selectedMatterId && loadingMatterClients ? "Loading clients..." : "Search clients"
                    }
                    disabled={selectedMatterId ? loadingMatterClients : false}
                    icon={<UserRound size={15} />}
                    portal
                  />
                  {clientScopeMatterId ? (
                    <p className="mt-1 text-xs text-on-surface-muted">
                      Showing clients linked to the selected matter.
                    </p>
                  ) : selectedMatterId && !selectedClientId && !loadingMatterClients && matterClients.length === 1 && resolvedClient?.name ? (
                    <p className="mt-1 text-xs text-on-surface-muted">
                      Using the only client on this matter for placeholder matching.
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {selectedMatter && (
                  <span className="inline-flex items-center rounded-full bg-surface px-2.5 py-1 text-xs text-on-surface-secondary border border-outline">
                    Matter: {selectedMatter.name}
                  </span>
                )}
                {resolvedClient && (
                  <span className="inline-flex items-center rounded-full bg-surface px-2.5 py-1 text-xs text-on-surface-secondary border border-outline">
                    Client: {resolvedClient.name}
                  </span>
                )}
                {lawFirm?.name && (
                  <span className="inline-flex items-center rounded-full bg-surface px-2.5 py-1 text-xs text-on-surface-secondary border border-outline">
                    Firm: {lawFirm.name}
                  </span>
                )}
                <span className="inline-flex items-center rounded-full bg-surface px-2.5 py-1 text-xs text-on-surface-secondary border border-outline">
                  Date: {new Date().toLocaleDateString()}
                </span>
              </div>
            </div>

            {template.fields.length === 0 && repeaters.length === 0 ? (
              <p className="text-sm text-on-surface-muted text-center py-4">
                This template has no fields. You can still download it as-is.
              </p>
            ) : (
              <>
                {/* Regular fields */}
                {regularFields.map(field => (
                  <div key={field}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <label className="block text-sm font-medium text-on-surface">{field} *</label>
                      <Tooltip title="Show where this field appears" enterDelay={300}>
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={() => setFieldUsagePreviewTarget({ name: field, label: field })}
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-on-surface-muted transition-[background-color,color,transform] hover:bg-surface-hover hover:text-on-surface active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                        >
                          <Eye size={12} />
                          View line
                        </button>
                      </Tooltip>
                    </div>
                    <TextInput
                      type="text"
                      value={values[field] ?? ""}
                      onChange={e => {
                        const val = e.target.value;
                        setValues(v => ({ ...v, [field]: val }));
                        if (!manuallyEdited.has(field)) {
                          setManuallyEdited(prev => new Set(prev).add(field));
                        }
                      }}
                      placeholder={autoFillValues[field] ? `Suggested: ${autoFillValues[field]}` : `Enter ${field}`}
                    />
                  </div>
                ))}

                {/* Repeater sections */}
                {repeaters.map((r) => {
                  const rows = repeaterValues[r.name] ?? [];
                  return (
                    <div key={r.name} className="rounded-lg border border-accent-border-soft dark:border-accent-border-soft bg-accent-soft dark:bg-accent-soft p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <Repeat size={14} className="text-accent-emphasis shrink-0" />
                        <span className="text-sm font-semibold text-on-surface truncate">{r.name}</span>
                        <span className="text-xs text-on-surface-muted shrink-0 tabular-nums">
                          ({rows.length} {rows.length === 1 ? "row" : "rows"})
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            const autoSub = repeaterAutoFill[r.name] ?? {};
                            setRepeaterValues((prev) => ({
                              ...prev,
                              [r.name]: [...(prev[r.name] ?? []), Object.fromEntries(r.fields.map((f) => [f, autoSub[f] ?? ""]))],
                            }));
                          }}
                          className="ml-auto shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-accent-emphasis bg-accent-soft dark:bg-accent-soft hover:bg-surface-hover dark:hover:bg-accent-soft transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                        >
                          <Plus size={12} />
                          Add Row
                        </button>
                      </div>

                      {rows.length === 0 && (
                        <p className="text-xs text-on-surface-muted text-center py-2">
                          No rows yet. Click &quot;Add Row&quot; to start.
                        </p>
                      )}

                      {rows.map((row, rowIdx) => (
                        <div key={rowIdx} className="rounded-md border border-outline bg-surface p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-on-surface-secondary">Row {rowIdx + 1}</span>
                            <Tooltip title="Remove row" enterDelay={300}>
                              <button aria-label="Remove row"
                                type="button"
                                onClick={() => {
                                  setRepeaterValues((prev) => ({
                                    ...prev,
                                    [r.name]: (prev[r.name] ?? []).filter((_, i) => i !== rowIdx),
                                  }));
                                }}
                                className="text-on-surface-muted hover:text-red-500 transition-colors cursor-pointer"
                              >
                                <Trash2 size={13} />
                              </button>
                            </Tooltip>
                          </div>
                          <div className="grid gap-2 md:grid-cols-2">
                            {r.fields.map((field) => (
                              <div key={field}>
                                <div className="mb-0.5 flex items-center justify-between gap-2">
                                  <label className="block text-xs font-medium text-on-surface">{field} *</label>
                                  <Tooltip title="Show where this field appears" enterDelay={300}>
                                    <button
                                      type="button"
                                      tabIndex={-1}
                                      onClick={() => setFieldUsagePreviewTarget({ name: `${r.name}.${field}`, label: `${r.name}.${field}` })}
                                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-on-surface-muted transition-[background-color,color,transform] hover:bg-surface-hover hover:text-on-surface active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
                                    >
                                      <Eye size={11} />
                                      View line
                                    </button>
                                  </Tooltip>
                                </div>
                                <input
                                  type="text"
                                  value={row[field] ?? ""}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setRepeaterValues((prev) => {
                                      const updated = [...(prev[r.name] ?? [])];
                                      updated[rowIdx] = { ...updated[rowIdx], [field]: val };
                                      return { ...prev, [r.name]: updated };
                                    });
                                  }}
                                  placeholder={repeaterAutoFill[r.name]?.[field] ? `Suggested: ${repeaterAutoFill[r.name][field]}` : `Enter ${field}`}
                                  className="w-full rounded-md border border-input-border bg-input-bg text-on-surface placeholder:text-on-surface-muted px-2.5 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-6 py-4 bg-surface-alt rounded-b-lg border-t border-outline shrink-0">
            <Tooltip title="Save to files" enterDelay={300}>
              <button aria-label="Save to files"
                onClick={handleOpenSaveModal}
                disabled={uploading || exporting || previewing}
                className="flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input-border bg-surface px-4 py-2 text-sm font-medium text-on-surface transition-[background-color,transform] hover:bg-surface-hover active:scale-[0.96] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
              >
                {saved ? (
                  <Check size={14} className="text-green-500" />
                ) : (
                  <FolderUp size={14} />
                )}
                {saved ? "Saved!" : "Save to Files"}
              </button>
            </Tooltip>
            <div ref={dropdownRef} className="relative">
              <div className="flex">
                <Tooltip title="Download as PDF" enterDelay={300}>
                  <button
                    onClick={() => handleDownload("pdf")}
                    disabled={exporting || uploading || previewing}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-l-lg text-sm font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                  >
                    {exporting ? (
                      <Spinner />
                    ) : (
                      <Download size={14} />
                    )}
                    Download
                  </button>
                </Tooltip>
                <Tooltip title="More download formats" enterDelay={300}>
                  <button
                    onClick={() => setShowFormats(v => !v)}
                    disabled={exporting || uploading || previewing}
                    className="flex items-center px-2 py-2 rounded-r-lg text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover border-l border-accent-control-ring disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                    aria-label="More download formats"
                  >
                    <ChevronDown size={14} />
                  </button>
                </Tooltip>
              </div>

              {formatsMounted && (
                <div className={`absolute right-0 bottom-full mb-1 bg-surface border border-outline-subtle rounded-xl shadow-lg z-50 min-w-[180px] p-1 origin-bottom-right ${menuAnim(formatsExiting)}`}>
                  {downloadFormats.map(f => (
                    <button
                      key={f.value}
                      onClick={() => {
                        setShowFormats(false);
                        handleDownload(f.value);
                      }}
                      className="w-full text-left px-2.5 py-2 rounded-lg text-sm text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

      <SaveToFilesModal
        open={showSaveModal}
        onClose={closeSaveModal}
        onConfirm={handleConfirmSave}
        lawFirmId={lawFirmId}
        defaultMatterId={selectedMatterId || undefined}
        defaultFileName={`${template.name}.pdf`}
        saving={uploading}
      />

      {/* Opened from inside this dialog, so it stacks above it. */}
      <Modal
        isOpen={Boolean(fieldUsagePreviewTarget)}
        onClose={() => setFieldUsagePreviewTarget(null)}
        stacked
        size="2xl"
        showClose={false}
        labelledBy={fieldUsageTitleId}
        bodyClassName={null}
        className="overflow-hidden"
      >
        <div className="flex items-center justify-between border-b border-outline px-5 py-3">
          <div>
            <h3 id={fieldUsageTitleId} className="text-sm font-semibold text-on-surface">Field Usage</h3>
            <p className="mt-0.5 text-xs text-on-surface-muted">{fieldUsageDisplayTarget?.label}</p>
          </div>
          <button
            type="button"
            onClick={() => setFieldUsagePreviewTarget(null)}
            className="rounded-md p-1.5 text-on-surface-muted transition-[background-color,color,transform] hover:bg-surface-hover hover:text-on-surface active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            aria-label="Close field usage preview"
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-3 overflow-y-auto overflow-x-hidden px-5 py-4 styled-scrollbar">
          {!fullTemplate?.html ? (
            <div className="flex items-center gap-2 rounded-lg border border-outline bg-surface-alt px-4 py-3 text-sm text-on-surface-muted">
              <Spinner />
              Loading the relevant line...
            </div>
          ) : fieldUsagePreview && fieldUsagePreview.matches.length > 0 ? (
            fieldUsagePreview.matches.map((match, index) => (
              <div key={`${match.pageLabel}-${index}`} className="rounded-xl border border-outline bg-surface-alt p-4">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-on-surface-muted">
                  {match.pageLabel}
                </p>
                <div
                  className="rounded-lg border border-outline bg-surface px-4 py-3 text-sm text-on-surface shadow-sm"
                  dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(match.html) }}
                />
              </div>
            ))
          ) : (
            <div className="rounded-lg border border-dashed border-outline px-4 py-6 text-center text-sm text-on-surface-muted">
              This field does not appear in a previewable line yet.
            </div>
          )}
        </div>
      </Modal>
    </Modal>
    {renderNotice && (
      <Toast message={renderNotice} tone="warning" duration={8000} onDismiss={() => setRenderNotice(null)} />
    )}
    </>
  );
}
