/**
 * The panel surface: rounded, outlined, with the one-pixel lift every card in the
 * product carries.
 *
 * The shadow is spelled as an arbitrary value rather than a Tailwind `shadow-*`
 * step because none of the steps match it. That is exactly why it was worth
 * extracting: an arbitrary value copied by hand 35 times is a value nobody can
 * change later, and a near-miss copy is invisible next to the real one.
 *
 * `overflow-hidden` is part of the base because the radius has to clip whatever
 * sits at the card's edge, most often a table header or a divided list.
 */
export const CARD_CLS =
  "bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden";

interface CardProps extends Omit<React.ComponentPropsWithRef<"div">, "className"> {
  /**
   * Extra classes, appended. The ones already in use are layout, not decoration:
   * `divide-y divide-outline-subtle` for a list card, `h-full` / `flex-1 min-h-0`
   * for a card in a grid or flex row, `min-w-0` to let it shrink.
   */
  className?: string;
  children: React.ReactNode;
}

export default function Card({ className = "", children, ...rest }: CardProps) {
  return (
    <div {...rest} className={className ? `${CARD_CLS} ${className}` : CARD_CLS}>
      {children}
    </div>
  );
}
