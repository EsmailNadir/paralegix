"use client";

import { motion, useReducedMotion } from "framer-motion";

/** Shared easing for every marketing entrance/crossfade: fast start, gentle settle. */
export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

/**
 * Fades and lifts children into place the first time they scroll into view.
 * Wrap a mockup or media block with this so the page reads as happening
 * rather than just present, without re-triggering on every scroll pass.
 */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduceMotion ? false : { opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.6, ease: EASE_OUT, delay }}
    >
      {children}
    </motion.div>
  );
}
