"use client";

import { motion, useReducedMotion } from "framer-motion";
import { EASE_OUT } from "./Reveal";

/**
 * Renders the page's <main> with a fade-and-lift entrance. Each marketing route
 * remounts on navigation, so the animation replays on every page switch while
 * the sticky nav and footer stay fixed in place.
 */
export default function MarketingTransition({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.main
      id="main-content"
      tabIndex={-1}
      className={className}
      initial={reduceMotion ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.45, ease: EASE_OUT }}
    >
      {children}
    </motion.main>
  );
}
