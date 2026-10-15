"use client";

import { useEffect, useRef, useState } from "react";
import useAnchoredMenuPosition from "./useAnchoredMenuPosition";
import { useMountTransition } from "./useMountTransition";

/** Animated right-aligned action menu, dismissed when its surrounding page moves. */
export default function useActionMenu({ clampHorizontal = false }: { clampHorizontal?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const { mounted, exiting } = useMountTransition(open, 150);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const coords = useAnchoredMenuPosition({ open: mounted, anchorRef: btnRef, menuRef, estimatedHeight: 0, align: "right", clampHorizontal });

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node) || btnRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const dismiss = () => setOpen(false);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  return { open, setOpen, mounted, exiting, btnRef, menuRef, coords, toggle: () => setOpen(value => !value) };
}
