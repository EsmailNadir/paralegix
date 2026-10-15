"use client";

import { useEffect, useState } from "react";
import { Check, Link2 } from "lucide-react";
import Button from "@/components/ui/Button";

/**
 * Copy an open payment request's secure link, to send it by text or message.
 * Says "Copied" for a moment so the firm knows it worked.
 */
export default function CopyPaymentLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
        } catch {
          // A browser that blocks the clipboard gets the link to copy by hand.
          window.prompt("Copy this payment link:", url);
        }
      }}
      type="secondary"
      size="small"
      className="w-full"
      icon={copied ? <Check className="w-4 h-4" /> : <Link2 className="w-4 h-4" />}
    >
      {copied ? "Copied" : "Copy Payment Link"}
    </Button>
  );
}
