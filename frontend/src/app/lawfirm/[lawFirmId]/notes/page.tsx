"use client";

import { useParams } from "next/navigation";
import FirmNotesGrid from "@/components/notesComp/FirmNotesGrid";

export default function FirmNotesPage() {
  const params = useParams();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";
  if (!lawFirmId) return null;

  return <FirmNotesGrid lawFirmId={lawFirmId} />;
}
