"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import contactsService from "@/services/contacts.service";
import type { Contact } from "@/types";

/**
 * Checks whether an accessible contact already uses the name or email being
 * typed into the create form. Advisory only: the caller shows a warning but
 * never disables or alters the save action.
 */
export function useContactDuplicateCheck(
  lawFirmId: string | undefined,
  name: string,
  email: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const [debounced, setDebounced] = useState({ name: "", email: "" });

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced({ name: name.trim(), email: email.trim() }), 300);
    return () => window.clearTimeout(timer);
  }, [name, email]);

  const { name: checkName, email: checkEmail } = debounced;
  const { data, isFetching } = useQuery<{ duplicates: Contact[] }>({
    queryKey: ["contacts", lawFirmId, "duplicate-check", checkName, checkEmail],
    queryFn: () => contactsService.checkDuplicates(lawFirmId!, { name: checkName, email: checkEmail }),
    enabled: enabled && !!lawFirmId && (checkName.length > 0 || checkEmail.length > 0),
    staleTime: 30_000,
  });

  // Hide a stale result while the next value is still inside the debounce
  // window, so the warning never lags a field the user has since changed.
  const isCurrent = checkName === name.trim() && checkEmail === email.trim();
  const duplicates = isCurrent ? data?.duplicates ?? [] : [];
  return { duplicates, checking: isFetching };
}
