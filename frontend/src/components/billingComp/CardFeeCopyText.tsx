"use client";

import NavigationLink from "@/components/ui/NavigationLink";
import { INLINE_LINK_CLASS } from "@/components/ui/LinkifiedText";
import { STRIPE_SUPPORT_URL, type CardFeeLinkTarget, type CopyPart } from "@/lib/payments/cardFeeCopy";

const IN_APP_PATHS: Record<Exclude<CardFeeLinkTarget, "stripe_support">, string> = {
  payments_settings: "settings/payments",
};

/**
 * A card fee sentence from `cardFeeCopy`, with its linked phrase as a link:
 * in-app destinations go through the app's navigation, and Stripe support
 * opens in a new tab. `onNavigate` runs before an in-app link is followed, so
 * a dialog can close itself on the way out.
 */
export default function CardFeeCopyText({
  parts,
  lawFirmId,
  onNavigate,
}: {
  parts: readonly CopyPart[];
  lawFirmId: string;
  onNavigate?: () => void;
}) {
  return (
    <>
      {parts.map((part, index) => {
        if (typeof part === "string") return part;
        if (part.to === "stripe_support") {
          return (
            <a key={index} href={STRIPE_SUPPORT_URL} target="_blank" rel="noopener noreferrer" className={INLINE_LINK_CLASS}>
              {part.link}
            </a>
          );
        }
        return (
          <NavigationLink key={index} href={`/lawfirm/${lawFirmId}/${IN_APP_PATHS[part.to]}`} onClick={onNavigate} className={INLINE_LINK_CLASS}>
            {part.link}
          </NavigationLink>
        );
      })}
    </>
  );
}
