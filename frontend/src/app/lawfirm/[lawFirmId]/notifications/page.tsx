"use client";

import { useParams } from "next/navigation";
import NotificationsView from "@/components/notificationComp/NotificationsView";

export default function NotificationsPage() {
  const params = useParams();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";
  if (!lawFirmId) return null;
  return <NotificationsView lawFirmId={lawFirmId} />;
}
