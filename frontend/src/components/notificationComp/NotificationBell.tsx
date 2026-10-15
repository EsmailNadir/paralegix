"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Bell } from "lucide-react";
import { useUnreadCount } from "@/hooks/notificationHooks/useNotifications";
import { useNotificationsRealtime } from "@/hooks/notificationHooks/useNotificationsRealtime";
import { useMountTransition } from "@/hooks/useMountTransition";
import NotificationDropdown from "./NotificationDropdown";

interface NotificationBellProps {
  lawFirmId: string;
}

export default function NotificationBell({ lawFirmId }: NotificationBellProps) {
  const { unreadCount } = useUnreadCount(lawFirmId);
  // Push-based refresh: invalidates the count + feed caches when a notification
  // row changes for this user. The hooks' 10-minute interval is only a backstop.
  useNotificationsRealtime(lawFirmId);
  const [open, setOpen] = useState(false);
  const { mounted, exiting } = useMountTransition(open, 150);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; direction: "up" | "down" } | null>(null);

  // Calculate dropdown position when opening
  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    // 320px on phones and 384px from the sm breakpoint up. The width is applied
    // as an inline style from this same value rather than by breakpoint classes,
    // so the placement below can never be computed for a panel of another size.
    const dropdownWidth = Math.min(window.innerWidth >= 640 ? 384 : 320, window.innerWidth - 16);
    // The bell renders in two slots: the desktop sidebar footer, at the left of
    // the screen, and the mobile top bar, at the right. So the panel picks the
    // side that keeps it attached to the bell rather than assuming one.
    //
    // Growing rightward from the bell's left edge is the preference, because
    // that is where the sidebar mount has the room. In the top bar it ran off
    // the right of the screen, and the clamp below then parked the panel against
    // the left margin, floating under the hamburger with its right edge nowhere
    // near the bell that opened it. Flipping first anchors the panel's right
    // edge to the bell's, so it hangs directly under the control.
    let left = rect.left;
    if (left + dropdownWidth > window.innerWidth - 8) {
      left = rect.right - dropdownWidth;
    }
    // Last resort on a screen too narrow for either side: keep it on screen.
    if (left + dropdownWidth > window.innerWidth - 8) {
      left = window.innerWidth - dropdownWidth - 8;
    }
    if (left < 8) left = 8;

    // Decide vertical direction: prefer opening upward (above the bell), but if
    // there isn't enough room above for the panel (max-h ~70vh), open downward.
    const margin = 8;
    const maxPanelHeight = window.innerHeight * 0.7;
    const spaceAbove = rect.top - margin;
    const spaceBelow = window.innerHeight - rect.bottom - margin;

    if (spaceAbove >= maxPanelHeight || spaceAbove >= spaceBelow) {
      // Open upward: anchor the panel's bottom at the top of the bell (it grows
      // upward via translateY(-100%) in the render, capped by max-h-[70vh]).
      setPos({ top: rect.top, left, width: dropdownWidth, direction: "up" });
    } else {
      // Open downward from the bottom of the bell.
      setPos({ top: rect.bottom, left, width: dropdownWidth, direction: "down" });
    }
  }, []);

  const handleToggle = () => {
    if (!open) {
      updatePosition();
    }
    setOpen(!open);
  };

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (
        buttonRef.current && !buttonRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Reposition on scroll/resize
  useEffect(() => {
    if (!open) return;
    const handler = () => updatePosition();
    window.addEventListener("resize", handler);
    window.addEventListener("scroll", handler, true);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("scroll", handler, true);
    };
  }, [open, updatePosition]);

  return (
    <>
      <button
        ref={buttonRef}
        onClick={handleToggle}
        className="relative p-1.5 rounded-lg text-on-surface-muted hover:text-on-surface hover:bg-surface-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
        aria-label="Notifications"
      >
        <Bell size={20} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 rounded-full bg-accent-solid text-accent-foreground text-[10px] font-bold flex items-center justify-center px-1">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {mounted && pos && typeof document !== "undefined" && createPortal(
        // Portaled to document.body: `position: fixed` is otherwise scoped to
        // the nearest transformed/filtered ancestor rather than the viewport,
        // and the sidebar's mobile drawer applies exactly such a transform
        // around this component's mount point.
        <NotificationDropdown
          ref={dropdownRef}
          lawFirmId={lawFirmId}
          onClose={() => setOpen(false)}
          exiting={exiting}
          direction={pos.direction}
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            width: pos.width,
            zIndex: 9999,
            transform: pos.direction === "up" ? "translateY(-100%)" : undefined,
          }}
        />,
        document.body,
      )}
    </>
  );
}
