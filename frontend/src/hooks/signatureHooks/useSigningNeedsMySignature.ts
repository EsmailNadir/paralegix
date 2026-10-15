'use client';

import { useQuery } from '@tanstack/react-query';
import { REFRESH_ON_FOCUS } from '@/lib/query/lawFirmQueryClient';
import signaturesService from '@/services/signatures.service';

export interface NeedsMySignatureDocument {
  sessionToken: string;
  fileName: string;
  createdAt: string | null;
  participantRole: string;
  publicToken: string | null;
  totalParticipants: number;
  completedParticipants: number;
}

/**
 * The documents in this firm waiting on the signed-in member's own signature.
 *
 * Answered by the server across the firm's whole set, which is the point: the
 * session list is paged by recent activity, so a document genuinely waiting on
 * this member can sit several pages deep with nothing on screen saying so.
 *
 * Resolves to an empty list on failure - this drives a call-to-action above the
 * list, and it should stay silent rather than put an error over a page that
 * otherwise loaded.
 *
 * `enabled: false` holds the read back while the page's combined workspace
 * request is filling this entry.
 */
export function useSigningNeedsMySignature(lawFirmId: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { data } = useQuery<NeedsMySignatureDocument[]>({
    queryKey: ['signingNeedsMySignature', lawFirmId],
    queryFn: async () => {
      const result = await signaturesService.getPendingForUser(lawFirmId);
      return result.needsMySignature ?? [];
    },
    enabled: enabled && !!lawFirmId,
    // External signers and other members move sessions along with nothing
    // pushing that here, so re-read on return to the tab.
    ...REFRESH_ON_FOCUS,
  });

  return { documents: data ?? [] };
}

export default useSigningNeedsMySignature;
