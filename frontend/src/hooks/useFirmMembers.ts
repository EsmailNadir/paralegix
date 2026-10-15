import { useQuery } from "@tanstack/react-query";
import lawfirmService from "@/services/lawfirm.service";

export interface FirmMember {
  id: string;
  name: string;
  email: string;
  photoUrl?: string | null;
}

/**
 * Firm members for @mention autocomplete. Returns a stable, lightweight
 * `{ id, name, email }[]`. Cached per firm; mention pickers read from this so
 * the user id is captured at selection time (never name-matched server-side).
 *
 * `enabled` lets a caller whose picker lives in a closed modal hold the request
 * back until the modal opens. The cache key is unchanged.
 */
export function useFirmMembers(lawFirmId?: string, enabled: boolean = true) {
  const { data } = useQuery<FirmMember[]>({
    queryKey: ["firmMembers", lawFirmId],
    queryFn: async () => {
      const members = await lawfirmService.getLawFirmMembers(lawFirmId!);
      return (members || [])
        .map((m: any) => ({
          id: m.userId || m.id,
          name: m.name || m.email || "Unknown",
          email: m.email || "",
          photoUrl: m.photoUrl ?? null,
        }))
        .filter((m: FirmMember) => !!m.id);
    },
    enabled: enabled && !!lawFirmId,
    staleTime: 5 * 60_000,
  });

  return data ?? [];
}
