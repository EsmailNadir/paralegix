import type { SlidingHighlightRect } from "@/hooks/useSlidingHighlight";

/** Sliding background shared by the law-firm and client sidebar nav lists. */
export default function SidebarActiveHighlight({ rect }: { rect: SlidingHighlightRect | null }) {
  if (!rect) return null;

  return (
    <span
      aria-hidden
      className="absolute left-0 top-0 z-0 rounded-xl bg-accent-soft transition-[transform,width,height] duration-[220ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
      style={{
        width: rect.width,
        height: rect.height,
        transform: `translate(${rect.left}px, ${rect.top}px)`,
      }}
    />
  );
}
