'use client';

import { createContext, useContext } from 'react';
import type { PortalAssociation } from '@/services/client-portal.service';

export interface ClientPortalFirm {
  id: string;
  name: string;
  logoUrl?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

// Re-exported under the context's own name so consumers don't need to know the
// association type actually lives on the service (mirrors ClientPortalFirm).
export type ClientPortalAssociation = PortalAssociation;

interface ClientPortalContextValue {
  // The firms this client belongs to, fetched once by the client layout. Shared
  // so portal pages can resolve a firm name without each re-requesting
  // /client-portal/my-lawfirms.
  lawFirms: ClientPortalFirm[];
  // Every client-record association (person and/or company roster links) this
  // portal uid holds in the CURRENTLY VIEWED firm, resolved by the client
  // layout from GET /client-portal/lawfirm/:lawFirmId/associations. Empty when
  // no firm is in view (e.g. the cross-firm dashboard) or before the first
  // resolve completes.
  associations: ClientPortalAssociation[];
  // True while `associations` for the current firm is still being resolved.
  associationsLoading: boolean;
  // The association currently scoping every clientRecordId-aware portal
  // request: auto-selected when exactly one association exists, otherwise the
  // client's persisted-or-picked choice. Null until resolved.
  activeAssociation: ClientPortalAssociation | null;
  // True once resolution has finished, more than one association exists, and
  // none is (yet) active - the portal's CLIENT_SELECTION_REQUIRED state. A
  // page should render a picker instead of attempting its normal fetch.
  selectionRequired: boolean;
  // Switch the active client record: persists the choice (per firm) and
  // updates every consumer immediately.
  setActiveClientRecordId: (clientRecordId: string) => void;
}

const noop = () => {};

export const ClientPortalContext = createContext<ClientPortalContextValue>({
  lawFirms: [],
  associations: [],
  associationsLoading: false,
  activeAssociation: null,
  selectionRequired: false,
  setActiveClientRecordId: noop,
});

export function useClientPortal() {
  return useContext(ClientPortalContext);
}
