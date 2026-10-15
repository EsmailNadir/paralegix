"use client";

import {
  AtSign, Bell, Briefcase, ClipboardCheck, CreditCard, FileText, FileX2, FolderUp,
  Landmark, MessageSquare, PenTool, Receipt, RotateCcw, StickyNote,
} from "lucide-react";
import type { Notification } from "@/services/notifications.service";

/** Picks the Lucide icon for a notification by its type (falls back to a bell). */
export default function NotificationIcon({
  notification,
  size = 13,
  className = "",
}: {
  notification: Pick<Notification, "type" | "entityType">;
  size?: number;
  className?: string;
}) {
  const props = { size, className: className || "shrink-0" };
  switch (notification.type) {
    case "task_assigned":
      return <ClipboardCheck {...props} />;
    case "message":
      return <MessageSquare {...props} />;
    case "mention":
      return <AtSign {...props} />;
    case "matter_added":
    case "member_role_changed":
      return <Briefcase {...props} />;
    case "invoice_paid":
    case "invoice_issued":
    case "invoice_overdue":
    case "invoice_credit_note_added":
      return <Receipt {...props} />;
    case "signing_requested":
    case "signing_reminder":
    case "signing_completed":
      return <PenTool {...props} />;
    case "signing_declined":
      return <FileX2 {...props} />;
    case "invoice_payment_reversed":
    case "invoice_payment_recredited":
      return <RotateCcw {...props} />;
    case "document_requested":
      return <FileText {...props} />;
    case "document_uploaded":
    case "file_shared":
      return <FolderUp {...props} />;
    case "trust_deposit_received":
    case "trust_low_balance":
    case "trust_reversal_failed":
    case "trust_deposit_failed":
      return <Landmark {...props} />;
    case "subscription_payment_failed":
    case "subscription_trial_ending":
      return <CreditCard {...props} />;
    default:
      // Fall back by entity when the type is unknown.
      if (notification.entityType === "note") return <StickyNote {...props} />;
      if (notification.entityType === "file") return <FolderUp {...props} />;
      return <Bell {...props} />;
  }
}
