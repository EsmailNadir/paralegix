"use client";

import { X } from "lucide-react";
import DocumentViewerModal from "@/components/ui/DocumentViewerModal";

/** Live preview of a public intake form, as a prospective client would see it. */
export default function IntakeFormPreviewModal({
  open,
  url,
  name,
  onClose,
}: {
  open: boolean;
  url: string | null;
  name: string;
  onClose: () => void;
}) {

  return (
    <DocumentViewerModal presentation="intake"
      isOpen={open}
      onClose={onClose}
      title={name ? `${name} Preview` : "Intake Form Preview"}
      closeIcon={<X size={18} />}
    >
      <iframe src={url ?? undefined} className="h-full w-full border-0" title="Intake Form Preview" />
    </DocumentViewerModal>
  );
}
