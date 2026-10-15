import type { Permission } from '@/lib/constants/permissions';

export interface Member {
  id?: string;
  userId: string;
  lawFirmId?: string;
  name: string;
  email?: string;
  photoUrl?: string | null;
  roleId?: string | null;
  isOwner?: boolean;
  /** Role display name derived by the members endpoint from `roleId`. */
  role?: string | null;
  resolvedPermissions?: Permission[] | string[];
  permissions?: Permission[] | string[];
  joinedAt?: Date | string | null;
  hourlyRate?: number | null;
  defaultHourlyRate?: number | null;
  totalHours?: number;
  createdAt?: string;
  updatedAt?: string;
}

