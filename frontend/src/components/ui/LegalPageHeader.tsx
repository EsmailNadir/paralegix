"use client";

import Link from "next/link";
import SkipLink from "@/components/ui/SkipLink";
import ParalegixLogo from "@/components/ui/ParalegixLogo";

export default function LegalPageHeader() {
  return (
    <>
      <SkipLink />
      <header className="bg-surface border-b border-outline">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center py-4">
          <Link href="/" aria-label="Paralegix home" className="cursor-pointer">
            <ParalegixLogo width={180} height={45} priority />
          </Link>
          <nav aria-label="Account" className="flex items-center space-x-4">
            <Link
              href="/login"
              className="text-on-surface-secondary hover:text-on-surface px-4 py-2 text-sm font-medium transition-colors duration-200 cursor-pointer"
            >
              Sign In
            </Link>
            <Link
              href="/register"
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-[background-color,color,transform] duration-200 active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              Get Started
            </Link>
          </nav>
        </div>
      </div>
    </header>
    </>
  );
}
