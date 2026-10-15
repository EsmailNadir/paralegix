"use client";

import Dropdown from "@/components/ui/Dropdown";
import type { Role } from "@/types/role";

export default function RoleSelector({
  roles,
  value,
  onChange,
  disabled = false,
  label,
  className,
}: {
  roles: Role[];
  value?: string | null;
  onChange: (roleId: string) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <Dropdown
      label={label}
      value={value || ""}
      onChange={onChange}
      options={roles.map((role) => ({
        value: role.id,
        label: role.name,
      }))}
      placeholder={roles.length ? "Select role" : "No roles available"}
      disabled={disabled || roles.length === 0}
      className={className}
      portal
    />
  );
}

