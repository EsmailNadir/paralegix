"use client";

function normalizeRoleName(roleName?: string | null) {
  if (!roleName) return "Unknown";
  return roleName.trim();
}

function dotColor(roleName: string, isOwner?: boolean) {
  const normalized = roleName.toLowerCase();
  if (isOwner || normalized === "owner") return "bg-amber-400";
  if (/\badmin\b/.test(normalized)) return "bg-indigo-400";
  if (/\battorney\b/.test(normalized)) return "bg-blue-400";
  if (/\bparalegal\b/.test(normalized)) return "bg-emerald-400";
  if (/\b(staff|member)\b/.test(normalized)) return "bg-slate-400";
  return "bg-violet-400";
}

export default function RoleBadge({
  roleName,
  isOwner,
  className = "",
}: {
  roleName?: string | null;
  isOwner?: boolean;
  className?: string;
}) {
  const name = normalizeRoleName(roleName);

  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border border-outline-subtle bg-surface px-2.5 py-1 text-xs font-medium text-on-surface-secondary",
        className,
      ].join(" ")}
    >
      <span className={["size-1.5 shrink-0 rounded-full", dotColor(name, isOwner)].join(" ")} />
      {isOwner ? "Owner" : name}
    </span>
  );
}
