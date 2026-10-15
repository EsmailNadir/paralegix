"use client";

import { useParams } from "next/navigation";
import ContactsGrid from "@/components/contactsComp/ContactsGrid";
import RequirePermission from "@/components/ui/RequirePermission";

export default function ContactsPage() {
  const params = useParams();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || "";
  if (!lawFirmId) return null;

  return (
    <RequirePermission permission="contacts.view" page>
      <ContactsGrid lawFirmId={lawFirmId} />
    </RequirePermission>
  );
}
