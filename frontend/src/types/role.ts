import type { Permission } from '@/lib/constants/permissions';

export interface Role {
  id: string;
  lawFirmId?: string;
  roleId?: string;
  name: string;
  isBuiltIn?: boolean;
  permissions: Permission[] | string[];
  createdAt?: string;
  updatedAt?: string;
}

