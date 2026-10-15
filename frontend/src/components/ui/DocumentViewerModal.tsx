"use client";

import type { ComponentProps, ReactNode } from "react";
import Modal from "./Modal";

type Presentation = "template" | "document" | "intake";
type Props = Omit<ComponentProps<typeof Modal>, "size" | "height" | "className" | "bodyClassName" | "showClose"> & {
  presentation: Presentation;
};

const PRESENTATIONS = {
  template: { size: "5xl", className: "rounded-xl border border-outline", bodyClassName: null, showClose: false },
  document: { size: "screen", className: "rounded-md border border-outline shadow-lg", bodyClassName: null, showClose: false },
  intake: { size: "3xl", bodyClassName: "min-h-0 flex-1 bg-surface-alt", showClose: true },
} as const;

/** Each viewer keeps its established geometry while sharing the dialog lifecycle. */
export default function DocumentViewerModal({ presentation, ...props }: Props) {
  return <Modal {...props} {...PRESENTATIONS[presentation]} height="fill" />;
}

export function DocumentViewerHeader({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-outline bg-surface-alt rounded-t-md shrink-0">{children}</div>;
}
