import { Fragment, type ReactNode } from "react";
import ListSkeleton from "@/components/ui/ListSkeleton";
import type { FileInfo } from "@/services/files.service";
import { FilePickerFolderRow } from "./FilePickerRow";

export default function FolderBrowserBody({ loading, label, children }: {
  loading: boolean;
  label: string;
  children: ReactNode;
}) {
  return loading ? <ListSkeleton rows={4} label={label} bordered={false} /> : children;
}

/** The folder id is both the row key and the navigation target. */
export function FolderBrowserRows({ folders, onOpen, renderRow, showFileCount = false, trailingAuto = false }: {
  folders: FileInfo[];
  onOpen: (folder: FileInfo) => void;
  renderRow?: (folder: FileInfo) => ReactNode;
  showFileCount?: boolean;
  trailingAuto?: boolean;
}) {
  return folders.map((folder) => renderRow
    ? <Fragment key={folder.id}>{renderRow(folder)}</Fragment>
    : <FilePickerFolderRow key={folder.id} folder={folder} onOpen={onOpen}
      fileCount={showFileCount ? folder.fileCount : undefined} trailingAuto={trailingAuto} />);
}
