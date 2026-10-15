"use client";

import { useState, useRef, useEffect, useId, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, X, ChevronDown, BriefcaseBusiness, UserRound, Sparkles, FolderUp, Check, Plus, Trash2, Repeat, Eye, Pencil } from "lucide-react";
import ErrorNotification from "@/components/ErrorNotification";
import EntityPicker from "@/components/ui/EntityPicker";
import Modal from "@/components/ui/Modal";
import Spinner from "@/components/ui/Spinner";
import TagChip from "@/components/ui/TagChip";
import TextInput from "@/components/ui/TextInput";
import Tooltip from "@/components/ui/Tooltip";
import { menuAnim } from "@/components/ui/transitionClasses";
import { useMountTransition, useResetAfterClose } from "@/hooks/useMountTransition";
import { useEntityByIds, type FullLookupItem } from "@/hooks/useEntityLookup";
import { useLawFirm } from "@/contexts/LawFirmContext";
import mattersService from "@/services/matters.service";
import filesService from "@/services/files.service";
import { wordTemplatesService, type DocumentContext } from "@/services/wordTemplates.service";
import { scopeFromIds } from "@/lib/files/fileScope";
import { getMatterLeadNames } from "@/lib/matters/leadNames";
import { getErrorMessage } from "@/lib/utils/apiErrors";
import { sanitizeRichHtml } from "@/lib/utils/sanitizeHtml";
import type { Client, LawFirm, Matter, MatterClient } from "@/types";
import type {
  WordTemplate as Template,
  WordTemplateFillDraft as TemplateFillDraft,
  WordTemplateRepeater as TemplateRepeater,
  WordTemplateWithHtml as TemplateWithHtml,
} from "@/types/wordTemplate";
import SaveToFilesModal, { type SaveDestination } from "@/components/templatesComp/SaveToFilesModal";
import { injectTemplatePreviewStyles } from "@/lib/wordTemplates/template-preview";
import { buildHydratedFilledTemplateHtml } from "@/lib/wordTemplates/template-fill";
import { fieldLabel, normalizeFieldKey, resolveCanonicalId, stripJudgeTitle } from "@/lib/wordTemplates/vocabulary";
// Layer 1 of the autofill: values assembled server-side for the picked matter
// and client, keyed by the canonical vocabulary and matched onto the
// template's own tag names, so a tag typed as "{Client Name}" or
// "{CASE_NUMBER}" still finds the value the server fetched. Layer 2 (the
// build*ValueMap heuristics below) covers hand-authored templates the
// vocabulary does not know.
import {
  normalizeInitialRepeaterValues,
  normalizeInitialValues,
  resolveProvidedRows,
  resolveProvidedValues,
} from "@/lib/wordTemplates/fill-values";
import { resolveFillEngine } from "@/lib/wordTemplates/fill-engine";

/**
 * The matter as the alias autofill reads it. Built from the matter the picker
 * hands back, under the names the alias maps below were written against.
 */
type Case = {
  id: string;
  name: string;
  caseNumber?: string | null;
  caseReferenceId?: string | null;
  description?: string | null;
  status?: string | null;
  practiceAreaName?: string | null;
  category?: string | null;
  leadUserName?: string | null;
  courtName?: string | null;
  opposingParty?: string | null;
  judgeName?: string | null;
  charges?: string | null;
  prosecutorName?: string | null;
  prosecutorEmail?: string | null;
};

/** A client attached to the matter, as the matter's client list returns it. */
type CaseClient = MatterClient;

function toCase(matter: Matter | null): Case | null {
  if (!matter) return null;
  return {
    id: matter.id,
    name: matter.name,
    caseNumber: matter.matterNumber,
    caseReferenceId: matter.matterReferenceId,
    description: matter.description,
    status: matter.status,
    practiceAreaName: matter.practiceAreaName,
    category: matter.category,
    leadUserName: getMatterLeadNames(matter).join(", ") || null,
    courtName: matter.courtName,
  };
}

// ODT/RTF dropped vs legacy, they need a LibreOffice converter that can't
// run on this serverless stack. PDF (puppeteer) / Word (html-to-docx) / TXT
// are produced directly by /api/templates/export.
type DownloadFormat = "pdf" | "docx" | "odt" | "rtf" | "txt";

const downloadFormats: { value: DownloadFormat; label: string }[] = [
  { value: "pdf", label: "PDF" },
  { value: "docx", label: "Word (DOCX)" },
  { value: "txt", label: "Plain Text (TXT)" },
];

interface FillTemplateModalProps {
  open: boolean;
  template: Template;
  lawFirmId: string;
  // The server's DOCX to PDF converter is available: Word templates can also be
  // downloaded as PDF (filled docx, then LibreOffice, then PDF).
  converterEnabled?: boolean;
  onClose: () => void;
  onEdit?: (templateId: string, fillDraft: TemplateFillDraft) => void;
  initialValues?: Record<string, string>;
  initialRepeaterValues?: Record<string, Record<string, string>[]>;
  initialSelectedCaseId?: string;
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
};


function sanitizePreviewClone(node: HTMLElement) {
  node.removeAttribute("contenteditable");
  node.removeAttribute("data-placeholder-chip-selected");

  // Strip unsafe elements (script, style, object, embed, iframe, form, base).
  node.querySelectorAll("script,style,object,embed,iframe,form,base").forEach((el) => el.remove());

  // Strip all event-handler attributes (on*) and unsafe href/src schemes across the tree.
  [node, ...Array.from(node.querySelectorAll("*"))].forEach((el) => {
    const attrs = Array.from(el.attributes);
    for (const attr of attrs) {
      if (/^on/i.test(attr.name)) {
        el.removeAttribute(attr.name);
      } else if (attr.name === "href" || attr.name === "src" || attr.name === "action") {
        if (/^javascript:/i.test(attr.value.trim())) {
          el.removeAttribute(attr.name);
        }
      }
    }
  });

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
    const normalizedAlias = normalizeFieldKey(alias);
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

function findMatchingCaseClient(client: Client | null, caseClients: CaseClient[]): CaseClient | null {
  if (!client) return null;

  const clientNameKey = normalizeFieldKey(client.name ?? "");
  return (
    caseClients.find((caseClient) => {
      const candidateUserId = caseClient.userId?.trim();
      return Boolean(
        (candidateUserId && (candidateUserId === client.id || candidateUserId === client.userId))
        || caseClient.id === client.id
        || (clientNameKey && normalizeFieldKey(caseClient.name) === clientNameKey)
      );
    }) ?? null
  );
}

function resolveClientSource(client: Client | null, caseClient: CaseClient | null): ResolvedClientSource | null {
  if (!client && !caseClient) return null;

  return {
    id: client?.id ?? caseClient?.id ?? "",
    name: caseClient?.name || client?.name || "Unnamed Client",
    email: caseClient?.email ?? client?.email,
    phone: caseClient?.phone ?? client?.phone,
    address: caseClient?.address ?? client?.address,
    organization: caseClient?.organization ?? client?.organization,
    preferredContactMethod: caseClient?.preferredContactMethod ?? client?.preferredContactMethod,
    status: client?.status,
  };
}

function buildCaseValueMap(caseItem: Case | null) {
  const map: Record<string, string> = {};
  if (!caseItem) return map;

  setAliases(map, ["case", "case_name", "case_title", "matter", "matter_name"], caseItem.name);
  setAliases(map, ["case_number", "case_no", "case_num", "matter_number", "file_number", "file_no", "docket_number"], caseItem.caseNumber);
  setAliases(map, ["case_reference_id", "reference_id", "matter_reference_id"], caseItem.caseReferenceId);
  setAliases(map, ["case_description"], caseItem.description);
  setAliases(map, ["case_status"], caseItem.status);
  setAliases(map, ["practice_area", "practice_area_name"], caseItem.practiceAreaName);
  setAliases(map, ["case_category", "category"], caseItem.category);
  setAliases(map, ["lead_attorney", "lead_user_name", "lead_lawyer", "attorney_name"], caseItem.leadUserName);

  // Court-filing fields (document automation vocabulary).
  setAliases(map, ["court", "court_name"], caseItem.courtName);
  setAliases(map, ["court_name_caps"], caseItem.courtName?.toUpperCase());
  // Strip a doubled judicial title, the caption already prints "JUDGE:".
  const judgeName = caseItem.judgeName ? stripJudgeTitle(caseItem.judgeName) : caseItem.judgeName;
  setAliases(map, ["judge", "judge_name"], judgeName);
  setAliases(map, ["judge_name_caps"], judgeName?.toUpperCase());
  setAliases(map, ["charges", "charge", "offenses"], caseItem.charges);
  setAliases(map, ["opposing_party", "facility_name", "facility"], caseItem.opposingParty);
  setAliases(map, ["prosecutor", "prosecutor_name", "service_recipient"], caseItem.prosecutorName);
  setAliases(map, ["prosecutor_email", "service_recipient_email"], caseItem.prosecutorEmail);
  // No prosecutor on file → serve the court (setAliases skips already-set keys).
  setAliases(map, ["service_recipient"], caseItem.courtName);

  return map;
}

function buildClientValueMap(client: ResolvedClientSource | null) {
  const map: Record<string, string> = {};
  if (!client) return map;

  const { firstName, lastName } = splitName(client.name);

  setAliases(map, ["client", "client_name", "name", "full_name"], client.name);
  // Document-automation vocabulary: the case client doubles as the criminal
  // defendant (caption) and the ODH resident.
  setAliases(map, ["defendant_name", "resident_name"], client.name);
  setAliases(map, ["defendant_name_caps"], client.name?.toUpperCase());
  setAliases(map, ["client_salutation"], firstName);
  setAliases(map, ["client_first_name", "first_name"], firstName);
  setAliases(map, ["client_last_name", "last_name", "surname"], lastName);
  setAliases(map, ["client_email", "email", "email_address"], client.email);
  setAliases(map, ["client_phone", "phone", "phone_number", "telephone", "mobile", "mobile_phone"], client.phone);
  setAliases(map, ["client_address", "client_location", "address", "street_address", "mailing_address"], client.address);
  setAliases(map, ["client_organization", "organization", "company", "company_name"], client.organization);
  setAliases(map, ["client_preferred_contact_method", "preferred_contact_method", "contact_method"], client.preferredContactMethod);
  setAliases(map, ["client_status"], client.status);

  return map;
}

function buildDateValueMap() {
  const map: Record<string, string> = {};
  const now = new Date();

  setAliases(map, ["today", "current_date", "date", "todays_date", "document_date"], now.toLocaleDateString());
  setAliases(map, ["full_date", "long_date", "date_long"], now.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }));
  setAliases(map, ["letter_date"], now.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }));
  // Certificate-of-service style: "4th day of March 2026".
  setAliases(map, ["service_date_legal"], formatLegalServiceDate(now));
  setAliases(map, ["year", "current_year"], String(now.getFullYear()));
  setAliases(map, ["month", "current_month"], now.toLocaleDateString(undefined, { month: "long" }));
  setAliases(map, ["day", "current_day", "day_of_month"], String(now.getDate()));

  return map;
}

function formatLegalServiceDate(now: Date): string {
  const day = now.getDate();
  const mod100 = day % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? "th"
      : day % 10 === 1
        ? "st"
        : day % 10 === 2
          ? "nd"
          : day % 10 === 3
            ? "rd"
            : "th";
  const month = now.toLocaleDateString(undefined, { month: "long" });
  return `${day}${suffix} day of ${month} ${now.getFullYear()}`;
}

function buildFirmValueMap(lawFirm: (LawFirm & { fax?: string | null }) | null) {
  const map: Record<string, string> = {};
  if (!lawFirm) return map;

  setAliases(map, ["firm", "firm_name", "law_firm", "law_firm_name"], lawFirm.name);
  setAliases(map, ["firm_address", "law_firm_address", "office_address"], lawFirm.address);
  setAliases(map, ["firm_city", "law_firm_city"], lawFirm.city);
  setAliases(map, ["firm_state", "law_firm_state"], lawFirm.state);
  setAliases(map, ["firm_zip", "law_firm_zip", "firm_postal_code"], lawFirm.zip);
  setAliases(map, ["firm_phone", "law_firm_phone", "office_phone"], lawFirm.phone);
  setAliases(map, ["firm_fax", "law_firm_fax", "office_fax", "fax"], lawFirm.fax);
  setAliases(map, ["firm_email", "law_firm_email", "office_email"], lawFirm.email);

  const fullAddress = [lawFirm.address, lawFirm.city, lawFirm.state, lawFirm.zip].filter(Boolean).join(", ");
  setAliases(map, ["firm_full_address", "law_firm_full_address"], fullAddress || null);

  // "Columbus, Ohio 43209", signature-block second line.
  const cityStateZip = [
    (lawFirm.city ?? "").trim(),
    [(lawFirm.state ?? "").trim(), (lawFirm.zip ?? "").trim()].filter(Boolean).join(" "),
  ].filter(Boolean).join(", ");
  setAliases(map, ["firm_city_state_zip"], cityStateZip || null);

  return map;
}

export default function FillTemplateModal({
  open,
  template,
  lawFirmId,
  converterEnabled = false,
  onClose,
  onEdit,
  initialValues,
  initialRepeaterValues,
  initialSelectedCaseId,
  initialSelectedClientId,
}: FillTemplateModalProps) {
  const titleId = useId();
  const fieldUsageTitleId = useId();
  // A Word template's inputs come from the tags in its stored FILE, not from the
  // row's `fields` copy, which can lag the file. Every tag the copy lacked used
  // to get no input and print blank. Until the file's list arrives generating
  // is blocked (see contextBusy); if it cannot be read, the stored list is used.
  const readsLiveFields = resolveFillEngine(template.type) === "docx";
  const { data: liveFields, isLoading: loadingLiveFields } = useQuery({
    queryKey: ["word-template-fill-live-fields", lawFirmId, template.id],
    queryFn: () => wordTemplatesService.fetchFillFields(lawFirmId, template.id),
    enabled: open && readsLiveFields && !!template.id,
    staleTime: 0,
  });
  const templateFields = liveFields?.fields ?? template.fields;
  const templateRepeaters = liveFields?.repeaters ?? template.repeaters;

  const repeaters: TemplateRepeater[] = useMemo(() => templateRepeaters ?? [], [templateRepeaters]);
  const repeaterFieldSet = useMemo(() => {
    const set = new Set<string>();
    for (const r of repeaters) {
      for (const f of r.fields) set.add(`${r.name}.${f}`);
    }
    return set;
  }, [repeaters]);
  const regularFields = useMemo(
    () => templateFields.filter((f) => !repeaterFieldSet.has(f)),
    [templateFields, repeaterFieldSet]
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
  const [downloaded, setDownloaded] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFormats, setShowFormats] = useState(false);
  const { mounted: formatsMounted, exiting: formatsExiting } = useMountTransition(showFormats, 150);
  const [fieldUsagePreviewTarget, setFieldUsagePreviewTarget] = useState<{ name: string; label: string } | null>(null);
  // This popover floats above the dialog with its own lifecycle, so it is
  // dismissed when the dialog closes.
  useResetAfterClose(open, () => setFieldUsagePreviewTarget(null));
  // Keeps its label while it animates out.
  const fieldUsageRetainedRef = useRef(fieldUsagePreviewTarget);
  if (fieldUsagePreviewTarget) fieldUsageRetainedRef.current = fieldUsagePreviewTarget;
  const fieldUsageDisplayTarget = fieldUsagePreviewTarget ?? fieldUsageRetainedRef.current;
  const [selectedCaseId, setSelectedCaseIdRaw] = useState(initialSelectedCaseId ?? "");
  const [selectedClientId, setSelectedClientIdRaw] = useState(initialSelectedClientId ?? "");
  // The full matter and client the pickers last handed back, so the alias map
  // has the whole record without waiting on a second round trip.
  const [pickedMatter, setPickedMatter] = useState<FullLookupItem | null>(null);
  const [pickedClient, setPickedClient] = useState<FullLookupItem | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Fields the user typed into. Values handed in by the opener (a
  // fill link's context) are NOT typed: they are protected by
  // restoredFieldsRef only until the next pick, which must be free to replace them.
  const [manuallyEdited, setManuallyEdited] = useState<Set<string>>(() => new Set());
  // Fields that were restored from a previous fill session, protected from auto-fill
  // until the user explicitly picks a new case/client (which clears this ref).
  const restoredFieldsRef = useRef<Set<string>>(new Set(restoredRegularFieldKeys));
  // The server's autofill (layer 1) for the current case/client pick. The
  // previous pick's values stay while the next one loads, so picking the client
  // after the case never blanks the fields in between; generating is blocked
  // until it lands (see contextBusy).
  const [serverContext, setServerContext] = useState<DocumentContext | null>(null);
  const [loadingCaseContext, setLoadingCaseContext] = useState(false);
  // Loops whose rows the user added, removed or typed into. A later pick never
  // replaces them, the same way a typed field is never overwritten.
  const [manualRepeaters, setManualRepeaters] = useState<Set<string>>(() => new Set());
  const claimRepeater = (name: string) =>
    setManualRepeaters((prev) => (prev.has(name) ? prev : new Set(prev).add(name)));
  // Bumped on every case pick. Re-picking the SAME case leaves selectedCaseId
  // untouched, so this is what lets a failed context fetch be retried.
  const [caseContextAttempt, setCaseContextAttempt] = useState(0);
  // Placeholders the last fill left as empty gaps in the generated document.
  const [unfilledFields, setUnfilledFields] = useState<string[]>([]);
  // The same report, readable synchronously right after a fill resolves, the
  // state update has not landed yet at the point a handler decides whether to
  // close the modal.
  const lastUnfilledRef = useRef<string[]>([]);
  // Whether the user has acknowledged generating with blank fields.
  const [blanksAcknowledged, setBlanksAcknowledged] = useState(false);

  // A pick re-derives every autofilled field but never touches one the user
  // typed: that value is theirs, and it is what the download must contain.
  const setSelectedCaseId = (id: string) => {
    setSelectedCaseIdRaw(id);
    if (!id) setPickedMatter(null);
    restoredFieldsRef.current = new Set();
    setBlanksAcknowledged(false);
    setUnfilledFields([]);
    setCaseContextAttempt((attempt) => attempt + 1);
  };
  const setSelectedClientId = (id: string) => {
    setSelectedClientIdRaw(id);
    if (!id) setPickedClient(null);
    restoredFieldsRef.current = new Set();
    setBlanksAcknowledged(false);
    setUnfilledFields([]);
    setCaseContextAttempt((attempt) => attempt + 1);
  };

  const { lawFirm } = useLawFirm();
  const { data: caseClients = [], isLoading: loadingCaseClients } = useQuery<CaseClient[]>({
    queryKey: ["word-template-fill-matter-clients", lawFirmId, selectedCaseId],
    queryFn: () => mattersService.listClients(lawFirmId, selectedCaseId),
    enabled: open && !!lawFirmId && !!selectedCaseId,
    staleTime: 60_000,
  });
  const { data: fullTemplate } = useQuery<TemplateWithHtml>({
    queryKey: ["word-template-fill-detail", lawFirmId, template.id],
    queryFn: () => wordTemplatesService.getById(lawFirmId, template.id),
    enabled: open && !!lawFirmId && !!template.id,
    staleTime: 60_000,
  });

  // The picker hands back the complete matter on selection; the id lookup covers
  // a matter id that arrived from the opener with nothing picked.
  const { items: selectedMatterItems } = useEntityByIds<FullLookupItem>(
    "matters",
    lawFirmId,
    selectedCaseId ? [selectedCaseId] : [],
    { full: true }
  );
  const selectedCase = useMemo(() => {
    if (pickedMatter && pickedMatter.id === selectedCaseId) return toCase(pickedMatter as unknown as Matter);
    const resolved = selectedMatterItems.find((item) => item.id === selectedCaseId);
    return toCase(resolved ? (resolved as unknown as Matter) : null);
  }, [pickedMatter, selectedMatterItems, selectedCaseId]);

  // The client picker is scoped to the matter's own clients once the matter is
  // known to have some; a matter with none falls back to the whole roster.
  const clientScopeMatterId =
    selectedCaseId && (loadingCaseClients || caseClients.length > 0) ? selectedCaseId : undefined;
  const { items: selectedClientItems } = useEntityByIds<FullLookupItem>(
    "clients",
    lawFirmId,
    selectedClientId ? [selectedClientId] : [],
    { matterId: clientScopeMatterId, full: true }
  );
  const selectedClient = useMemo(() => {
    if (pickedClient && pickedClient.id === selectedClientId) return pickedClient as unknown as Client;
    const resolved = selectedClientItems.find((item) => item.id === selectedClientId);
    return resolved ? (resolved as unknown as Client) : null;
  }, [pickedClient, selectedClientItems, selectedClientId]);

  const matchedCaseClient = useMemo(
    () => findMatchingCaseClient(selectedClient, caseClients),
    [selectedClient, caseClients]
  );

  const fallbackCaseClient = useMemo(
    () => (!selectedClient && caseClients.length === 1 ? caseClients[0] : null),
    [selectedClient, caseClients]
  );

  const resolvedClient = useMemo(
    () => resolveClientSource(selectedClient, matchedCaseClient ?? fallbackCaseClient),
    [selectedClient, matchedCaseClient, fallbackCaseClient]
  );

  const { autoFillValues, repeaterAutoFill } = useMemo(() => {
    // Layer 1 (server) outranks the alias heuristics: it knows the picked
    // client, the billing records and the firm-defined fields the aliases lack.
    const serverValues = resolveProvidedValues(regularFields, serverContext?.values);
    const caseValues = buildCaseValueMap(selectedCase);
    const clientValues = buildClientValueMap(resolvedClient);
    const firmValues = buildFirmValueMap(lawFirm);
    const dateValues = buildDateValueMap();

    const lookup = (key: string) => {
      const n = normalizeFieldKey(key);
      return clientValues[n] || caseValues[n] || firmValues[n] || dateValues[n] || "";
    };

    const af = Object.fromEntries(
      regularFields.map((field) => [field, serverValues[field] || lookup(field)])
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
  }, [regularFields, repeaters, selectedCase, resolvedClient, lawFirm, serverContext]);

  // The reset below is keyed on CONTENT, not object identity. A parent that
  // re-renders with equal props (one that refreshes after a save) hands in
  // fresh objects holding the same values, and resetting
  // on those used to wipe everything typed since the form opened.
  //
  // It reads the opener's RAW props rather than the values normalized against
  // the field list, so the file's field list arriving after open (see
  // liveFields) does not reset the form either.
  const initialStateKey = JSON.stringify([
    template.id,
    initialValues ?? null,
    initialRepeaterValues ?? null,
    initialSelectedCaseId ?? "",
    initialSelectedClientId ?? "",
  ]);

  useEffect(() => {
    // Resets multiple state values AND a ref (restoredFieldsRef) together on
    // template/initial-data change; the ref is read by the autofill effect
    // below, so the two must stay in lockstep. A during-render conversion would
    // need a ref write during render (disallowed) and risks a one-render skew
    // between state and ref, so this stays an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- coupled state+ref reset; see note
    setValues(normalizedInitialValues);
    setRepeaterValues(normalizedInitialRepeaterValues);
    setSelectedCaseIdRaw(initialSelectedCaseId ?? "");
    setSelectedClientIdRaw(initialSelectedClientId ?? "");
    setManuallyEdited(new Set());
    restoredFieldsRef.current = new Set(restoredRegularFieldKeys);
    setManualRepeaters(new Set());
    setUnfilledFields([]);
    setBlanksAcknowledged(false);
    // Every other input is captured by initialStateKey's content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialStateKey]);

  // Layer 1 (the server context) follows the current pick: the case AND the
  // client, since the document is about the client the user chose, and a client
  // picked with no case still has client, firm and date fields to fill. It runs
  // on mount too, so a form opened on a matter (a fill link with ?matterId=)
  // gets the same complete fill as one where the case was picked by hand.
  const contextKey = selectedCaseId || selectedClientId ? `${selectedCaseId}|${selectedClientId}` : "";
  useEffect(() => {
    if (!contextKey) {
      // Nothing picked: drop the previous pick's values, and end a load the
      // cleanup just cancelled, or generating would stay disabled.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on an emptied pick
      setServerContext(null);
      setLoadingCaseContext(false);
      return;
    }

    let cancelled = false;
    setLoadingCaseContext(true);

    wordTemplatesService
      .documentContext(lawFirmId, { matterId: selectedCaseId || null, clientId: selectedClientId || null })
      .then((context) => {
        if (!cancelled) setServerContext(context);
      })
      .catch(() => {
        if (cancelled) return;
        // Stale values from the previous pick would print the wrong matter.
        setServerContext(null);
        setError(
          "Couldn't load this matter's details, so the fields only it can fill are blank. Pick the matter again to retry.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingCaseContext(false);
      });

    return () => {
      cancelled = true;
    };
    // selectedCaseId / selectedClientId are folded into contextKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey, caseContextAttempt]);

  // Rows the server knows for a loop (the installment plan behind {#payments})
  // replace that loop's rows, unless the user has already worked on the loop.
  // Rows a PREVIOUS pick supplied go back to the opening rows when the new pick
  // has none: another client's installments must never print in this agreement.
  const serverLoopsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const contextRows = normalizeInitialRepeaterValues(repeaters, serverContext?.repeaterValues);
    const replace: Record<string, RepeaterRowValues[]> = {};
    for (const repeater of repeaters) {
      if (manualRepeaters.has(repeater.name)) continue;
      if (serverContext && resolveProvidedRows(repeater.name, serverContext.repeaterValues)) {
        replace[repeater.name] = contextRows[repeater.name];
        serverLoopsRef.current.add(repeater.name);
      } else if (serverLoopsRef.current.has(repeater.name)) {
        replace[repeater.name] = normalizedInitialRepeaterValues[repeater.name] ?? [];
        serverLoopsRef.current.delete(repeater.name);
      }
    }
    if (Object.keys(replace).length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- merge async server rows into loops the user has not touched
    setRepeaterValues((current) => ({ ...current, ...replace }));
    // normalizedInitialRepeaterValues is only read when a pick changes serverContext.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverContext, repeaters, manualRepeaters]);

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
    if (!selectedCaseId) return;
    if (loadingCaseClients) return;

    const currentClientStillRelated = caseClients.some((client) => client.id === selectedClientId);
    if (selectedClientId && currentClientStillRelated) return;
    // A client from outside the matter is a deliberate pick when the matter has none of its own.
    if (selectedClientId && caseClients.length === 0) return;

    if (!selectedClientId && caseClients.length !== 1) return;

    // Syncs the selected client to the matter's async-loaded clients (react-query).
    // Uses the RAW setter deliberately: the wrapped setSelectedClientId clears
    // restoredFieldsRef, which is correct when the USER picks a client but
    // wrong here: this automatic sync fires on mount for a
    // matter-prefilled fill (fill-link context values, restored drafts) and
    // clearing the protection let the alias autofill wipe every restored field
    // that has no alias suggestion (hearing_*, payment scalars).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync to async data; see note
    setSelectedClientIdRaw(caseClients.length === 1 ? caseClients[0].id : "");
  }, [selectedCaseId, selectedClientId, caseClients, loadingCaseClients]);

  useEffect(() => {
    setValues((currentValues) => {
      const nextValues = { ...currentValues };
      let changed = false;

      for (const field of regularFields) {
        if (manuallyEdited.has(field)) continue;
        if (restoredFieldsRef.current.has(field)) continue;
        const nextAutoValue = autoFillValues[field] ?? "";
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
    // Conditionally merges async-derived autofill values into existing repeater
    // rows via a functional updater (reads current state, fills only empty
    // cells). Not a plain reset-on-change, so it stays an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- conditional merge of async autofill into current state; see note
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

  // Deps are correct and exhaustive; the compiler cannot prove the manual memo
  // safe (likely the optional-chained dep), so we keep the intentional useMemo.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const fieldUsagePreview = useMemo(() => {
    if (!fieldUsagePreviewTarget || !fullTemplate?.html) return null;
    return buildFieldUsagePreview(
      fullTemplate.html,
      fieldUsagePreviewTarget.name,
      fieldUsagePreviewTarget.label
    );
  }, [fieldUsagePreviewTarget, fullTemplate?.html]);

  // The row's `type` decides which engine fills it, never the `html` column.
  // A Word template whose row still carries HTML from the old convert-on-open
  // editor must still fill natively against its stored .docx, or its formatting
  // is rebuilt (and wrecked) by html-to-docx. See fill-engine.ts.
  const fillEngine = resolveFillEngine(template.type);
  const isDocx = fillEngine === "docx";
  // A fillable-PDF template fills in place server-side and always comes back as
  // a flattened PDF, there is no other format for it, and the HTML export path
  // below would have nothing to work with (html is null for this type).
  const isPdfForm = fillEngine === "pdf-form";

  const getResolvedTemplate = async () => {
    return fullTemplate ?? await wordTemplatesService.getById(lawFirmId, template.id);
  };

  // Export the filled template.
  //   - HTML templates: the export route renders PDF, Word or text from the filled HTML
  //   - Word templates: native .docx fill, or PDF through the converter
  const exportBlob = async (format: DownloadFormat): Promise<Blob> => {
    const full = await getResolvedTemplate();
    // Each generate reports its own gaps; drop the previous run's.
    lastUnfilledRef.current = [];
    setUnfilledFields([]);

    if (isPdfForm) {
      if (format !== "pdf") {
        throw new Error("PDF form templates can only be downloaded as PDF.");
      }
      const filled = await wordTemplatesService.fillPdfFormTemplate(lawFirmId, template.id, values);
      lastUnfilledRef.current = filled.unfilledFields;
      setUnfilledFields(filled.unfilledFields);
      return filled.blob;
    }

    if (isDocx) {
      // Word templates fill natively as .docx. PDF is available only when the
      // document converter is available (filled docx, LibreOffice, PDF);
      // odt/rtf/txt remain unsupported on this stack.
      if (format === "docx" || (format === "pdf" && converterEnabled)) {
        const filled = await wordTemplatesService.fillDocxTemplate(lawFirmId, template.id, values, repeaterValues, format);
        lastUnfilledRef.current = filled.unfilledFields;
        setUnfilledFields(filled.unfilledFields);
        return filled.blob;
      }
      throw new Error(
        converterEnabled
          ? "Word templates can only be downloaded as .docx or PDF in this workspace."
          : "Word templates can only be downloaded as .docx in this workspace.",
      );
    }

    const assetPreviewUrls = Object.fromEntries(
      (full.assets ?? [])
        .filter((asset) => Boolean(asset.previewUrl))
        .map((asset) => [asset.id, asset.previewUrl as string])
    );
    const hydrated = await buildHydratedFilledTemplateHtml(full.html!, values, repeaterValues, assetPreviewUrls);
    const doc = injectTemplatePreviewStyles(hydrated, template.name);
    if (format !== "pdf" && format !== "docx" && format !== "txt") {
      throw new Error("Web templates can be downloaded as PDF, Word or plain text.");
    }
    return wordTemplatesService.exportHtml(lawFirmId, doc, format);
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

  // The form is only final once the current pick's details have loaded. A file
  // generated before that would ship every value still in flight as a blank.
  const contextBusy =
    loadingCaseContext ||
    (!!selectedCaseId && loadingCaseClients) ||
    (readsLiveFields && loadingLiveFields);

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

  // Classify each still-empty field for the persistent "Needs input" panel. A
  // field whose name resolves to a canonical fill key (vocabulary.ts) is one the
  // DB layer *could* fill but this case left blank ("empty for this case"); one
  // that resolves to nothing has no case-model source and must be typed in ("no
  // matching field in this case"). Repeater keys look like "name[1].field", so
  // classify by the leaf field.
  const missingClassified: { field: string; reason: "empty" | "no-source" }[] = hasEmptyFields
    ? getMissingFields().map((field) => {
        const leaf = field.slice(field.lastIndexOf(".") + 1);
        return { field, reason: resolveCanonicalId(leaf) ? ("empty" as const) : ("no-source" as const) };
      })
    : [];

  // A blank field warns instead of blocking: a paralegal may legitimately want a
  // document with one blank to complete by hand, and the old hard block left
  // them no way to get it. The first attempt still stops and points at the
  // "Needs input" panel, so a blank is never generated by accident, the second
  // one goes through. Changing the case or client resets the acknowledgement.
  const confirmBlankFields = (action: "previewing" | "downloading" | "saving") => {
    if (!hasEmptyFields) return true;
    if (blanksAcknowledged) return true;

    setBlanksAcknowledged(true);
    setError(
      `${missingClassified.length} ${missingClassified.length === 1 ? "field is" : "fields are"} still blank: see “Needs input” above. Continue ${action} to generate with them blank.`,
    );
    return false;
  };

  const handlePreview = async () => {
    if (contextBusy) return;
    if (!confirmBlankFields("previewing")) return;

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
      if (isPdfForm) {
        // The filled PDF is the finished document, show it directly. (The
        // HTML branch below has nothing to render for this type: html is null.)
        const pdfBlob = await exportBlob("pdf");
        const pdfUrl = URL.createObjectURL(pdfBlob);
        previewWindow.location.href = pdfUrl;
        window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 60_000);
        return;
      } else if (isDocx) {
        if (converterEnabled) {
          // Render the filled .docx to PDF on the server and show it inline.
          const pdfBlob = await exportBlob("pdf");
          const pdfUrl = URL.createObjectURL(pdfBlob);
          previewWindow.location.href = pdfUrl;
          window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 60_000);
          return;
        }
        // No converter on this stack, tell the user to download the .docx.
        previewWindow.close();
        setError("Preview isn't available for Word templates: use Download to get the .docx.");
        return;
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
    if (contextBusy) return;
    if (!confirmBlankFields("downloading")) return;
    setExporting(true);
    setError(null);
    try {
      const blob = await exportBlob(format);

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${template.name}.${format}`;
      a.click();
      URL.revokeObjectURL(url);

      // The modal holds the only copy of what was typed, and downloading is not
      // the end of the job, the same filled document is usually saved to files
      // or downloaded again in a second format. Closing here threw all of it
      // away, so the panel stays open and confirms on the button instead.
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 1200);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to download."));
    } finally {
      setExporting(false);
    }
  };

  const handleOpenSaveModal = () => {
    if (contextBusy) return;
    if (!confirmBlankFields("saving")) return;
    setError(null);
    setShowSaveModal(true);
  };

  // Dismissing the destination picker mid-save stops the save: nothing is filed.
  const saveAbortRef = useRef<AbortController | null>(null);
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
      // HTML templates save as PDF; Word templates save the native .docx.
      const saveFormat: DownloadFormat = isDocx ? "docx" : "pdf";
      const blob = await exportBlob(saveFormat);
      if (signal.aborted) return;
      const base = destination.fileName.replace(/\.[^.]+$/, "") || "document";
      const file = new File([blob], `${base}.${saveFormat}`, { type: blob.type });

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

  const actionsBusy = exporting || uploading || previewing || contextBusy;

  return (
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
                  <button
                    type="button"
                    aria-label="Edit template"
                    onClick={() =>
                      onEdit(template.id, {
                        values,
                        repeaterValues,
                        selectedCaseId,
                        selectedClientId,
                      })
                    }
                    disabled={exporting || uploading || previewing}
                    className="inline-flex size-8 items-center justify-center rounded-lg border border-input-border bg-surface text-on-surface-muted hover:text-on-surface hover:bg-surface-hover disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
                  >
                    <Pencil size={14} />
                  </button>
                </Tooltip>
              )}
              <Tooltip title="Preview filled document" enterDelay={300}>
                <button
                  type="button"
                  aria-label="Preview filled document"
                  onClick={handlePreview}
                  disabled={actionsBusy}
                  className="inline-flex size-8 items-center justify-center rounded-lg border border-input-border bg-surface text-on-surface-muted hover:text-on-surface hover:bg-surface-hover disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
                >
                  {previewing ? <Spinner /> : <Eye size={14} />}
                </button>
              </Tooltip>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="inline-flex size-8 items-center justify-center rounded-lg text-on-surface-muted hover:text-on-surface cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="px-6 py-5 space-y-4 overflow-y-scroll styled-scrollbar">
            <ErrorNotification error={error} onClose={() => setError(null)} />

            <div className="rounded-lg border border-outline bg-surface-alt p-4 space-y-4">
              <div className="flex items-start gap-2">
                <div className="mt-0.5 rounded-md bg-accent-soft px-2 py-1 text-accent-emphasis">
                  <Sparkles size={14} />
                </div>
                <div>
                  <p className="text-base font-semibold text-on-surface">Auto-fill from a matter or client</p>
                  <p className="text-xs text-on-surface-muted mt-0.5">
                    Pick a matter, client, or both to fill in fields such as Client name and Case number. Firm info and dates are filled automatically.
                  </p>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <EntityPicker<FullLookupItem>
                    entity="matters"
                    lawFirmId={lawFirmId}
                    full
                    label="Matter"
                    value={selectedCaseId}
                    onChange={setSelectedCaseId}
                    onSelectItem={setPickedMatter}
                    placeholder="Search matters"
                    icon={<BriefcaseBusiness size={15} />}
                    portal
                  />
                  {loadingCaseContext && (
                    <p className="mt-1 text-xs text-on-surface-muted">Loading this matter&apos;s details...</p>
                  )}
                </div>

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
                    placeholder={selectedCaseId && loadingCaseClients ? "Loading clients..." : "Search clients"}
                    disabled={selectedCaseId ? loadingCaseClients : false}
                    icon={<UserRound size={15} />}
                    portal
                  />
                  {selectedCaseId && caseClients.length > 0 ? (
                    <p className="mt-1 text-xs text-on-surface-muted">Showing clients linked to the selected matter.</p>
                  ) : selectedCaseId && !selectedClientId && !loadingCaseClients && caseClients.length === 1 && resolvedClient?.name ? (
                    <p className="mt-1 text-xs text-on-surface-muted">Using the only client on this matter for placeholder matching.</p>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {selectedCase && <TagChip label={`Matter: ${selectedCase.name}`} />}
                {resolvedClient && <TagChip label={`Client: ${resolvedClient.name}`} />}
                {lawFirm?.name && <TagChip label={`Firm: ${lawFirm.name}`} />}
                <TagChip label={`Date: ${new Date().toLocaleDateString()}`} />
              </div>
            </div>

            {missingClassified.length > 0 && (
              <div
                className="mb-4 rounded-lg border border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 p-3"
                data-testid="needs-input-panel"
              >
                <p className="mb-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
                  Needs input ({missingClassified.length})
                </p>
                <ul className="space-y-1">
                  {missingClassified.map((m) => (
                    <li key={m.field} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                      <span className="font-medium text-amber-600 dark:text-amber-400">{fieldLabel(m.field)}</span>
                      <span className="text-amber-600 dark:text-amber-400">
                        {m.reason === "empty"
                          ? "empty for this matter: fill it in below"
                          : "no matching field in this matter: enter manually"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {templateFields.length === 0 && repeaters.length === 0 ? (
              <p className="text-sm text-on-surface-muted text-center py-4">
                This template has no fields. You can still download it as-is.
              </p>
            ) : (
              <>
                {/* Regular fields */}
                {regularFields.map((field) => {
                  const inputId = `${titleId}-field-${field}`;
                  return (
                    <div key={field}>
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <label htmlFor={inputId} className="block text-sm font-medium text-on-surface">{fieldLabel(field)}</label>
                        <Tooltip title="Show where this field appears" enterDelay={300}>
                          <button
                            type="button"
                            onClick={() => setFieldUsagePreviewTarget({ name: field, label: fieldLabel(field) })}
                            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-sm font-medium text-on-surface-muted transition-colors hover:bg-surface-hover hover:text-on-surface cursor-pointer"
                          >
                            <Eye size={12} />
                            View line
                          </button>
                        </Tooltip>
                      </div>
                      <TextInput
                        id={inputId}
                        type="text"
                        value={values[field] ?? ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          setValues((v) => ({ ...v, [field]: val }));
                          if (!manuallyEdited.has(field)) {
                            setManuallyEdited((prev) => new Set(prev).add(field));
                          }
                        }}
                        placeholder={autoFillValues[field] ? `Suggested: ${autoFillValues[field]}` : `Enter ${fieldLabel(field)}`}
                        data-testid="fill-field-input"
                        data-field={field}
                      />
                    </div>
                  );
                })}

                {/* Repeater sections */}
                {repeaters.map((r) => {
                  const rows = repeaterValues[r.name] ?? [];
                  return (
                    <div key={r.name} className="rounded-lg border border-accent-border-soft bg-accent-soft/50 p-4 space-y-3">
                      <div className="flex items-center gap-2">
                        <Repeat size={14} className="text-accent-emphasis shrink-0" />
                        <span className="text-base font-semibold text-on-surface truncate">{fieldLabel(r.name)}</span>
                        <span className="text-xs text-on-surface-muted shrink-0 tabular-nums">
                          ({rows.length} {rows.length === 1 ? "row" : "rows"})
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            const autoSub = repeaterAutoFill[r.name] ?? {};
                            claimRepeater(r.name);
                            setRepeaterValues((prev) => ({
                              ...prev,
                              [r.name]: [...(prev[r.name] ?? []), Object.fromEntries(r.fields.map((f) => [f, autoSub[f] ?? ""]))],
                            }));
                          }}
                          className="ml-auto shrink-0 inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium text-accent-emphasis bg-accent-soft hover:bg-accent-soft transition-colors cursor-pointer"
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
                            <span className="text-sm font-medium text-on-surface-secondary">Row {rowIdx + 1}</span>
                            <Tooltip title="Remove row" enterDelay={300}>
                              <button
                                type="button"
                                aria-label="Remove row"
                                onClick={() => {
                                  claimRepeater(r.name);
                                  setRepeaterValues((prev) => ({
                                    ...prev,
                                    [r.name]: (prev[r.name] ?? []).filter((_, i) => i !== rowIdx),
                                  }));
                                }}
                                className="inline-flex size-6 items-center justify-center rounded-md text-on-surface-muted hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
                              >
                                <Trash2 size={13} />
                              </button>
                            </Tooltip>
                          </div>
                          <div className="grid gap-2 md:grid-cols-2">
                            {r.fields.map((field) => {
                              const inputId = `${titleId}-${r.name}-${rowIdx}-${field}`;
                              return (
                                <div key={field}>
                                  <div className="mb-0.5 flex items-center justify-between gap-2">
                                    <label htmlFor={inputId} className="block text-sm font-medium text-on-surface">{fieldLabel(field)}</label>
                                    <Tooltip title="Show where this field appears" enterDelay={300}>
                                      <button
                                        type="button"
                                        onClick={() => setFieldUsagePreviewTarget({ name: `${r.name}.${field}`, label: fieldLabel(field) })}
                                        className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-sm font-medium text-on-surface-muted transition-colors hover:bg-surface-hover hover:text-on-surface cursor-pointer"
                                      >
                                        <Eye size={11} />
                                        View line
                                      </button>
                                    </Tooltip>
                                  </div>
                                  <TextInput
                                    id={inputId}
                                    type="text"
                                    value={row[field] ?? ""}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      claimRepeater(r.name);
                                      setRepeaterValues((prev) => {
                                        const updated = [...(prev[r.name] ?? [])];
                                        updated[rowIdx] = { ...updated[rowIdx], [field]: val };
                                        return { ...prev, [r.name]: updated };
                                      });
                                    }}
                                    placeholder={repeaterAutoFill[r.name]?.[field] ? `Suggested: ${repeaterAutoFill[r.name][field]}` : `Enter ${fieldLabel(field)}`}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </>
            )}
          </div>

          <div className="shrink-0 rounded-b-lg border-t border-outline bg-surface-alt">
            {unfilledFields.length > 0 && (
              <p
                className="border-b border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 px-6 py-2 text-xs text-amber-600 dark:text-amber-400"
                data-testid="unfilled-fields-notice"
              >
                {unfilledFields.length} {unfilledFields.length === 1 ? "field" : "fields"} left blank
                in the generated document:{" "}
                <span>{[...new Set(unfilledFields.map(fieldLabel))].join(", ")}</span>
              </p>
            )}
            <div className="flex items-center justify-end gap-2 px-6 py-4">
              <Tooltip title="Save to files" enterDelay={300}>
                <button
                  type="button"
                  onClick={handleOpenSaveModal}
                  disabled={actionsBusy}
                  className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input-border bg-surface px-3 text-sm font-medium text-on-surface transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                >
                  {saved ? (
                    <Check size={14} className="text-green-600 dark:text-green-400" />
                  ) : (
                    <FolderUp size={14} />
                  )}
                  {saved ? "Saved!" : "Save to Files"}
                </button>
              </Tooltip>
              <div ref={dropdownRef} className="relative">
                <div className="flex">
                  <Tooltip title={isDocx ? "Download as Word (.docx)" : "Download as PDF"} enterDelay={300}>
                    <button
                      type="button"
                      onClick={() => handleDownload(isDocx ? "docx" : "pdf")}
                      disabled={actionsBusy}
                      className="inline-flex h-8 items-center gap-1.5 rounded-l-lg px-3 text-sm font-medium text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
                    >
                      {exporting ? <Spinner /> : downloaded ? <Check size={14} /> : <Download size={14} />}
                      {downloaded ? "Downloaded!" : "Download"}
                    </button>
                  </Tooltip>
                  <Tooltip title="More download formats" enterDelay={300}>
                    <button
                      type="button"
                      onClick={() => setShowFormats((v) => !v)}
                      disabled={actionsBusy}
                      className="inline-flex h-8 items-center rounded-r-lg px-2 text-accent-foreground bg-accent-solid hover:bg-accent-solid-hover border-l border-accent-control-ring disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
                      aria-label="More download formats"
                    >
                      <ChevronDown size={14} />
                    </button>
                  </Tooltip>
                </div>

                {formatsMounted && (
                  <div className={`absolute right-0 bottom-full mb-1 bg-surface border border-outline-subtle rounded-xl shadow-lg z-50 min-w-[180px] p-1 origin-bottom-right ${menuAnim(formatsExiting)}`}>
                    {/* Word templates export .docx; PDF too when the converter is on. */}
                    {downloadFormats
                      .filter((f) => {
                        // PDF-form templates only ever fill/export as PDF: see
                        // exportBlob's isPdfForm branch, which throws for any
                        // other format.
                        if (isPdfForm) return f.value === "pdf";
                        if (!isDocx) return true;
                        // Word templates always take the native docx fill path, so
                        // the offer has to match what exportBlob can actually
                        // produce: .docx, plus PDF when the converter is on.
                        return f.value === "docx" || (converterEnabled && f.value === "pdf");
                      })
                      .map((f) => (
                        <button
                          key={f.value}
                          type="button"
                          onClick={() => {
                            setShowFormats(false);
                            handleDownload(f.value);
                          }}
                          className="w-full text-left px-2.5 py-2 rounded-lg text-sm text-on-surface hover:bg-surface-hover transition-colors cursor-pointer"
                        >
                          {f.label}
                        </button>
                      ))}
                    {/* Make the DOCX to PDF fallback explicit rather than silently
                        dropping PDF: it needs the document converter. */}
                    {isDocx && !converterEnabled && (
                      <p className="border-t border-outline-subtle px-4 py-2 text-xs text-on-surface-muted">
                        PDF export needs the document converter (not enabled yet). Download as
                        Word (.docx) for now.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

      <SaveToFilesModal
        open={showSaveModal}
        onClose={closeSaveModal}
        onConfirm={handleConfirmSave}
        lawFirmId={lawFirmId}
        defaultMatterId={selectedCaseId || undefined}
        defaultFileName={`${template.name}.${isDocx ? "docx" : "pdf"}`}
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
            <h3 id={fieldUsageTitleId} className="text-base font-semibold text-on-surface">Field Usage</h3>
            <p className="mt-0.5 text-xs text-on-surface-muted">{fieldUsageDisplayTarget?.label}</p>
          </div>
          <button
            type="button"
            onClick={() => setFieldUsagePreviewTarget(null)}
            className="inline-flex size-8 items-center justify-center rounded-lg text-on-surface-muted transition-colors hover:bg-surface-hover hover:text-on-surface cursor-pointer"
            aria-label="Close field usage preview"
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-3 overflow-y-auto px-5 py-4 styled-scrollbar">
          {!fullTemplate?.html ? (
            <div className="flex items-center gap-2 rounded-lg border border-outline bg-surface-alt px-4 py-3 text-sm text-on-surface-muted">
              <Spinner />
              Loading the relevant line...
            </div>
          ) : fieldUsagePreview && fieldUsagePreview.matches.length > 0 ? (
            fieldUsagePreview.matches.map((match, index) => (
              <div key={`${match.pageLabel}-${index}`} className="rounded-xl border border-outline bg-surface-alt p-4">
                <p className="mb-2 text-sm font-medium uppercase tracking-[0.06em] text-on-surface-muted">
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
  );
}
