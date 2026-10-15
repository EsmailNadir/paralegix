"use client";

import type React from "react";
import StatusBadge from "@/components/ui/StatusBadge";
import { contactCategoryMeta } from "@/constants/statusMeta";

/**
 * What a contact is - either their directory category or the role they play on
 * one matter. Both read the same vocabulary, so both render through here.
 *
 * `children` replaces the word while keeping the colour, for the surfaces that
 * need to name the PERSON and colour them by what they are (an event's attendee
 * list, where "Jane Roe" in opposing-counsel red says more than a second badge
 * reading "Opposing Counsel"). The colour still comes from the shared meta, so
 * it can never drift from the badge next to it.
 */
export default function ContactCategoryBadge({
  category,
  className = "",
  children,
}: {
  category?: string | null;
  className?: string;
  children?: React.ReactNode;
}) {
  const { label, variant } = contactCategoryMeta(category);
  return (
    <StatusBadge variant={variant} className={className}>
      {children ?? label}
    </StatusBadge>
  );
}
