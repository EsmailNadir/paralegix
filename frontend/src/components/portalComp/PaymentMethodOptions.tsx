"use client";

import { CreditCard, Landmark, type LucideIcon } from "lucide-react";
import Spinner from "@/components/ui/Spinner";
import { formatCents } from "@/lib/utils/currency";
import type { PaymentMethodKind } from "@/services/client-portal.service";

const METHOD_META: Record<PaymentMethodKind, { label: string; Icon: LucideIcon }> = {
  card: { label: "Card", Icon: CreditCard },
  bank: { label: "Bank transfer", Icon: Landmark },
};

/**
 * Card or bank transfer, each with its fee and what the client pays. Shared by
 * the portal's payment dialog and the no-login pay page. `choosing` is the
 * method whose checkout is starting, which locks both.
 *
 * A method with a `subtitles` entry shows that line instead of its fee and no
 * total: a card fee depends on the card, so the card form shows the exact
 * total once the card is entered.
 */
export default function PaymentMethodOptions({
  methods,
  choosing,
  onChoose,
  subtitles,
}: {
  methods: Array<{ method: PaymentMethodKind; feeCents: number; totalCents: number }>;
  choosing: PaymentMethodKind | null;
  onChoose: (method: PaymentMethodKind) => void;
  subtitles?: Partial<Record<PaymentMethodKind, string>>;
}) {
  return (
    <div className="space-y-3">
      {methods.map(({ method, feeCents, totalCents }) => {
        const { label, Icon } = METHOD_META[method];
        const subtitle = subtitles?.[method];
        return (
          <button
            key={method}
            type="button"
            onClick={() => onChoose(method)}
            disabled={!!choosing}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left bg-surface border border-outline text-on-surface transition-all hover:border-accent-border-soft hover:shadow-md active:scale-[0.98] motion-reduce:active:scale-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Icon size={18} strokeWidth={1.8} className="shrink-0 text-on-surface-muted" />
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-xs text-on-surface-muted">
                {subtitle ?? (feeCents > 0 ? `+ ${formatCents(feeCents)} processing fee` : "No fee")}
              </span>
            </span>
            <span className="shrink-0 text-sm font-semibold">
              {choosing === method ? <Spinner size={16} /> : subtitle ? null : `You pay ${formatCents(totalCents)}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}
