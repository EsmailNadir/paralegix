export type AnnotationType = 'text' | 'signature';
export type SignatureStyle = 'standard' | 'x-line';
export type ToolMode = 'select' | 'text' | 'signature';

export interface BaseAnnotation {
  id: string;
  type: AnnotationType;
  page: number; // 1-indexed
  xPercent: number; // 0–100
  yPercent: number; // 0–100
  widthPercent: number; // 0–100
  heightPercent: number; // 0–100
}

export interface TextAnnotationData extends BaseAnnotation {
  type: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  isBold: boolean;
  isItalic: boolean;
  color: string;
}

export interface SignatureAnnotationData extends BaseAnnotation {
  type: 'signature';
  dataUrl: string; // base64 PNG
  style?: SignatureStyle;
}

export type Annotation = TextAnnotationData | SignatureAnnotationData;

export interface AnnotatorState {
  fileUrl: string | null;
  fileName: string | null;
  pdfBytes: Uint8Array | null;
  currentPage: number;
  totalPages: number;
  scale: number;
  mode: ToolMode;
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  defaultFontFamily: string;
  defaultFontSize: number;
  defaultBold: boolean;
  defaultItalic: boolean;
  defaultColor: string;
  defaultSignatureStyle: SignatureStyle;
  history: Annotation[][];
  future: Annotation[][];
  signatureModalOpen: boolean;
  signaturePlacement: { page: number; xPercent: number; yPercent: number } | null;
  isDownloading: boolean;
  isConverting: boolean;
  error: string | null;
}

export type AnnotatorAction =
  | { type: 'SET_FILE'; fileUrl: string; fileName: string; pdfBytes?: Uint8Array }
  | { type: 'SET_TOTAL_PAGES'; totalPages: number }
  | { type: 'SET_PAGE'; page: number }
  | { type: 'SET_SCALE'; scale: number }
  | { type: 'SET_MODE'; mode: ToolMode }
  | { type: 'ADD_ANNOTATION'; annotation: Annotation }
  | { type: 'UPDATE_ANNOTATION'; id: string; changes: Record<string, unknown> }
  | { type: 'SET_ANNOTATION_TEXT'; id: string; text: string }
  | { type: 'DELETE_ANNOTATION'; id: string }
  | { type: 'SELECT_ANNOTATION'; id: string | null }
  | { type: 'MOVE_ANNOTATION'; id: string; xPercent: number; yPercent: number }
  | { type: 'RESIZE_ANNOTATION'; id: string; widthPercent: number; heightPercent: number }
  | { type: 'SET_DEFAULT_STYLE'; fontFamily?: string; fontSize?: number; isBold?: boolean; isItalic?: boolean; color?: string }
  | { type: 'SET_DEFAULT_SIGNATURE_STYLE'; style: SignatureStyle }
  | { type: 'OPEN_SIGNATURE_MODAL'; page: number; xPercent: number; yPercent: number }
  | { type: 'CLOSE_SIGNATURE_MODAL' }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'SET_DOWNLOADING'; isDownloading: boolean }
  | { type: 'SET_CONVERTING'; isConverting: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'RESET' };

export const FONT_FAMILIES = [
  { label: 'Arial', value: 'Helvetica', css: 'Arial, Helvetica, sans-serif', pdfFont: 'Helvetica' },
  { label: 'Times New Roman', value: 'Times-Roman', css: "'Times New Roman', Times, serif", pdfFont: 'Times-Roman' },
  { label: 'Courier New', value: 'Courier', css: "'Courier New', Courier, monospace", pdfFont: 'Courier' },
  { label: 'Calibri', value: 'Calibri', css: "Calibri, Carlito, Arial, sans-serif", pdfFont: 'Helvetica' },
  { label: 'Cambria', value: 'Cambria', css: "Cambria, Georgia, serif", pdfFont: 'Times-Roman' },
  { label: 'Georgia', value: 'Georgia', css: 'Georgia, serif', pdfFont: 'Times-Roman' },
  { label: 'Verdana', value: 'Verdana', css: 'Verdana, Geneva, sans-serif', pdfFont: 'Helvetica' },
  { label: 'Tahoma', value: 'Tahoma', css: 'Tahoma, Geneva, sans-serif', pdfFont: 'Helvetica' },
  { label: 'Trebuchet MS', value: 'Trebuchet MS', css: "'Trebuchet MS', Helvetica, sans-serif", pdfFont: 'Helvetica' },
  { label: 'Garamond', value: 'Garamond', css: 'Garamond, serif', pdfFont: 'Times-Roman' },
  { label: 'Palatino', value: 'Palatino', css: "'Palatino Linotype', 'Book Antiqua', Palatino, serif", pdfFont: 'Times-Roman' },
  { label: 'Didot', value: 'Didot', css: "Didot, 'Bodoni MT', serif", pdfFont: 'Times-Roman' },
  { label: 'Futura', value: 'Futura', css: 'Futura, sans-serif', pdfFont: 'Helvetica' },
  { label: 'Optima', value: 'Optima', css: 'Optima, sans-serif', pdfFont: 'Helvetica' },
  { label: 'Avenir', value: 'Avenir', css: "'Avenir Next', Avenir, sans-serif", pdfFont: 'Helvetica' },
  { label: 'Lucida Console', value: 'Lucida Console', css: "'Lucida Console', Monaco, monospace", pdfFont: 'Courier' },
  { label: 'Comic Sans MS', value: 'Comic Sans MS', css: "'Comic Sans MS', cursive", pdfFont: 'Helvetica' },
  { label: 'Impact', value: 'Impact', css: 'Impact, Charcoal, sans-serif', pdfFont: 'Helvetica' },
  { label: 'Brush Script MT', value: 'Brush Script MT', css: "'Brush Script MT', cursive", pdfFont: 'Times-Roman' },
] as const;

export const FONT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72] as const;

export const DEFAULT_TEXT_ANNOTATION: Omit<TextAnnotationData, 'id' | 'page' | 'xPercent' | 'yPercent'> = {
  type: 'text',
  text: '',
  fontFamily: 'Helvetica',
  fontSize: 16,
  isBold: false,
  isItalic: false,
  color: '#000000',
  widthPercent: 20,
  heightPercent: 5,
};

export const TEXT_COLORS = [
  '#000000', '#374151', '#EF4444', '#3B82F6',
  '#10B981', '#F59E0B', '#8B5CF6', '#EC4899',
] as const;

export const DEFAULT_SIGNATURE_SIZE = {
  widthPercent: 15,
  heightPercent: 6,
};

export const DEFAULT_SIGNATURE_STYLE: SignatureStyle = 'standard';

export function resolveSignatureStyle(style?: SignatureStyle): SignatureStyle {
  return style === 'x-line' ? 'x-line' : DEFAULT_SIGNATURE_STYLE;
}

// --- Designated signature fields (placed by lawyer, filled by client) ---

export type FieldType = 'signature' | 'initials' | 'date' | 'text' | 'checkbox';
export type RoutingMode = 'sequential' | 'parallel';

export interface SignatureField {
  id: string;
  page: number;
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  fieldType?: FieldType;
  label?: string;
  required?: boolean;
  style?: SignatureStyle;
  signerId?: string;
}

export type SignerDeliveryMethod = 'email' | 'portal' | 'internal_dashboard' | 'internal_email' | 'in_person' | 'copy_link';

export interface SigningParticipant {
  participantId: string;
  roleLabel: string;
  order: number;
  deliveryMethod: SignerDeliveryMethod;
  name?: string;
  email?: string;
  memberUserId?: string;
  clientUserId?: string;
  accessCode?: string;
}

/**
 * One addressable recipient for an account-backed signing request (portal or
 * internal-dashboard delivery), from the dedicated recipient-selection
 * endpoint (`GET /signature-links/recipients`). Every company roster contact
 * is now a real, standalone Person client, so this list is just person
 * clients: a standalone person yields one row (`companyLinkId`/`companyName`
 * both null), and a person linked to one or more companies yields one row
 * per company link, so a signer can be addressed to the exact company
 * relationship rather than "the company" generically.
 */
export interface SigningRecipient {
  /** Firebase uid to send as a signer's `clientUserId` - who is actually asked to sign. */
  userId: string;
  name: string;
  email: string | null;
  /** This recipient's own `clients.id`. */
  clientId: string;
  clientName: string;
  clientType: 'person' | 'company';
  /** Set only when this row represents a company-linked person - the exact `client_company_links.id` it resolves to. */
  companyLinkId: string | null;
  /** The linked company's name, or null for a standalone person. */
  companyName: string | null;
}

/** One signer as the firm's session list reports them. */
export interface SigningParticipantSummary {
  participantId: string;
  roleLabel: string;
  name: string | null;
  email: string | null;
  status: string;
  order: number;
  deliveryMethod: string;
  /** When this signer signed. Null until they have. */
  completedAt?: string | null;
  /** True when this signer is the signed-in user. */
  isCurrentUser?: boolean;
}

/** Where a completed session's executed copy was filed, as the file browser addresses it. */
export interface SigningDestination {
  scope: 'firm' | 'matter' | 'task' | 'client';
  matterId?: string;
  taskId?: string;
  clientId?: string;
  /** Sub-folder inside that scope, '' at its root. */
  folderPath: string;
}

/** A signing session as it appears in the firm's signing history. */
export interface SigningSession {
  token: string;
  sessionToken?: string;
  fileName: string;
  status: string;
  signerName: string | null;
  recipientEmail: string | null;
  createdAt: string | null;
  completedAt: string | null;
  expiresAt?: string | null;
  destinationLabel?: string | null;
  destination?: SigningDestination | null;
  routingMode?: string;
  totalParticipants?: number;
  completedParticipants?: number;
  currentSignerName?: string | null;
  currentSignerRole?: string | null;
  readyForCurrentUser?: boolean;
  currentUserSigningToken?: string | null;
  signers?: SigningParticipantSummary[];
}

/**
 * How much each status filter would match across the firm's whole signing
 * history. Independent of the active filter, so the filters can go on labelling
 * themselves while one of them is applied.
 */
export interface SigningSessionSummary {
  /** Keyed by session status; a status with no sessions is absent, not 0. */
  counts: Record<string, number>;
  total: number;
  /** Everything not yet fully signed, whatever its status. */
  notCompleted: number;
}

export interface SigningTemplateRole {
  roleLabel: string;
  order: number;
  deliveryMethod?: SignerDeliveryMethod;
}

export interface SigningTemplate {
  templateId: string;
  name: string;
  description?: string;
  fields: SignatureField[];
  signerRoles: SigningTemplateRole[];
  sourceFileName?: string | null;
  sourceObjectPath?: string | null;
  routingMode?: RoutingMode;
  createdBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface SigningFieldValue {
  fieldId: string;
  value: string | boolean;
}

export const DEFAULT_FIELD_SIZE = {
  widthPercent: 20,
  heightPercent: 6,
};
