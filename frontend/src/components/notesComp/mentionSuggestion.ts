import type { FirmMember } from "@/hooks/useFirmMembers";

interface SuggestionItemProps {
  items: FirmMember[];
  command: (attrs: { id: string; label: string }) => void;
  clientRect?: (() => DOMRect | null) | null;
}

/**
 * Builds a Tiptap Mention `suggestion` config backed by a live firm-member
 * getter. Renders a small, self-contained DOM popup (no external popup lib)
 * positioned at the caret; selecting a member inserts a mention node carrying
 * the member's `id`. Keyboard: ↑/↓ to move, Enter/Tab to pick, Esc to close.
 */
export function createMentionSuggestion(getMembers: () => FirmMember[]) {
  return {
    items: ({ query }: { query: string }) => {
      const q = query.toLowerCase();
      return getMembers()
        .filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
        .slice(0, 6);
    },

    render: () => {
      let popup: HTMLDivElement | null = null;
      let items: FirmMember[] = [];
      let active = 0;
      let command: SuggestionItemProps["command"] | null = null;

      const renderList = () => {
        if (!popup) return;
        popup.innerHTML = "";
        items.forEach((m, i) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `w-full text-left px-3 py-2 cursor-pointer ${i === active ? "bg-surface-hover" : ""}`;
          btn.innerHTML = `<span class="block text-sm text-on-surface truncate">${escapeHtml(m.name)}</span>` +
            (m.email ? `<span class="block text-xs text-on-surface-muted truncate">${escapeHtml(m.email)}</span>` : "");
          btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            command?.({ id: m.id, label: m.name });
          });
          popup!.appendChild(btn);
        });
      };

      const position = (rect: DOMRect | null | undefined) => {
        if (!popup || !rect) return;
        popup.style.top = `${rect.bottom + window.scrollY + 4}px`;
        popup.style.left = `${rect.left + window.scrollX}px`;
      };

      return {
        onStart: (props: SuggestionItemProps) => {
          items = props.items;
          command = props.command;
          active = 0;
          popup = document.createElement("div");
          popup.className = "absolute z-[60] w-64 max-h-56 overflow-y-auto overflow-x-hidden styled-scrollbar rounded-lg border border-outline bg-surface shadow-xl";
          popup.style.position = "absolute";
          document.body.appendChild(popup);
          renderList();
          position(props.clientRect?.());
        },
        onUpdate: (props: SuggestionItemProps) => {
          items = props.items;
          command = props.command;
          active = 0;
          renderList();
          position(props.clientRect?.());
        },
        onKeyDown: (props: { event: KeyboardEvent }) => {
          const { event } = props;
          if (!items.length) return false;
          if (event.key === "ArrowDown") {
            active = (active + 1) % items.length;
            renderList();
            return true;
          }
          if (event.key === "ArrowUp") {
            active = (active - 1 + items.length) % items.length;
            renderList();
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            const m = items[active];
            if (m) command?.({ id: m.id, label: m.name });
            return true;
          }
          if (event.key === "Escape") {
            popup?.remove();
            popup = null;
            return true;
          }
          return false;
        },
        onExit: () => {
          popup?.remove();
          popup = null;
        },
      };
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
