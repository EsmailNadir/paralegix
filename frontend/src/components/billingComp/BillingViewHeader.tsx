"use client";

interface BillingViewHeaderProps {
  title: string;
  description: string;
}

// Small heading + one-line explainer shown at the top of each billing tab so
// the purpose of the view is clear without having to infer it from the content.
export default function BillingViewHeader({ title, description }: BillingViewHeaderProps) {
  return (
    <div className="mb-5">
      <h2 className="text-base font-semibold text-on-surface">{title}</h2>
      <p className="mt-0.5 text-sm text-on-surface-secondary">{description}</p>
    </div>
  );
}
