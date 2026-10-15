"use client";

import { Upload } from "lucide-react";
import Spinner from "@/components/ui/Spinner";

interface UploadZoneProps {
  converting: boolean;
  convertingDocx: boolean;
  isDragging: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onBrowse: () => void;
}

export function UploadZone({ converting, convertingDocx, isDragging, onDragOver, onDragLeave, onDrop, onBrowse }: UploadZoneProps) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onBrowse}
      className={`flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed py-20 transition-colors cursor-pointer ${
        isDragging
          ? "border-accent-border-soft bg-accent-soft dark:bg-accent-soft"
          : "border-outline bg-surface hover:border-accent-border-soft"
      }`}
    >
      {converting ? (
        <>
          <Spinner size={40} className="text-accent-emphasis" />
          <p className="text-sm text-on-surface-secondary font-medium">Preparing document…</p>
          <p className="text-xs text-on-surface-muted">
            {convertingDocx ? "Parsing DOCX placeholders" : "Converting to PDF and extracting layout"}
          </p>
        </>
      ) : (
        <>
          <div className="w-14 h-14 rounded-full bg-accent-soft dark:bg-accent-soft flex items-center justify-center">
            <Upload size={28} className="text-accent-emphasis" />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold text-on-surface">Drop a document here</p>
            <p className="text-xs text-on-surface-muted mt-1">or click to browse</p>
          </div>
          <p className="text-xs text-on-surface-muted">PDF, DOCX, DOC, ODT, RTF, and TXT</p>
        </>
      )}
    </div>
  );
}
