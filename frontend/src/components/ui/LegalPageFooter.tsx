"use client";

import Link from "next/link";
import CookieSettingsLink from "@/components/ui/CookieSettingsLink";

interface LegalPageFooterProps {
  currentPage: "terms" | "privacy" | "subprocessors";
}

export default function LegalPageFooter({ currentPage }: LegalPageFooterProps) {
  return (
    <footer>
      <nav aria-label="Legal" className="mt-8 text-center text-xs text-on-surface-muted">
      <Link
        href="/privacy"
        aria-current={currentPage === "privacy" ? "page" : undefined}
        className={`hover:text-on-surface transition-colors cursor-pointer ${currentPage === "privacy" ? "font-medium" : ""}`}
      >
        Privacy Policy
      </Link>
      <span className="mx-2">|</span>
      <Link
        href="/terms"
        aria-current={currentPage === "terms" ? "page" : undefined}
        className={`hover:text-on-surface transition-colors cursor-pointer ${currentPage === "terms" ? "font-medium" : ""}`}
      >
        Terms of Service
      </Link>
      <span className="mx-2">|</span>
      <Link
        href="/subprocessors"
        aria-current={currentPage === "subprocessors" ? "page" : undefined}
        className={`hover:text-on-surface transition-colors cursor-pointer ${currentPage === "subprocessors" ? "font-medium" : ""}`}
      >
        Sub-processors
      </Link>
      <span className="mx-2">|</span>
      <CookieSettingsLink className="hover:text-on-surface transition-colors" />
    </nav>
    </footer>
  );
}
