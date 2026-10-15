import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import rolesService from '@/services/roles.service';
import type { Role } from '@/types/role';

const BUILT_IN_ROLE_RANK: Record<string, number> = {
  Owner: 0,
  Admin: 1,
  Attorney: 2,
  Paralegal: 3,
  Staff: 4,
};

function roleSort(a: Role, b: Role) {
  if (!!a.isBuiltIn !== !!b.isBuiltIn) {
    return a.isBuiltIn ? -1 : 1;
  }
  if (a.isBuiltIn && b.isBuiltIn) {
    const rankA = BUILT_IN_ROLE_RANK[a.name] ?? Number.MAX_SAFE_INTEGER;
    const rankB = BUILT_IN_ROLE_RANK[b.name] ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
  }
  return (a.name || '').localeCompare(b.name || '');
}

export function useRoles(lawFirmId: string | undefined) {
  const queryClient = useQueryClient();

  const { data: roles, isLoading, error, refetch } = useQuery<Role[]>({
    queryKey: ['roles', lawFirmId],
    queryFn: async () => {
      const data = await rolesService.listRoles(lawFirmId!);
      return (data || []).slice().sort(roleSort);
    },
    enabled: !!lawFirmId,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['roles', lawFirmId] }),
    [queryClient, lawFirmId],
  );

  const createRole = useCallback(
    async (data: { name: string; permissions: string[] }) => {
      if (!lawFirmId) throw new Error('Law firm ID is required');
      const created = await rolesService.createRole(lawFirmId, data);
      await invalidate();
      return created;
    },
    [lawFirmId, invalidate],
  );

  const updateRole = useCallback(
    async (roleId: string, data: Partial<Pick<Role, 'name' | 'permissions'>>) => {
      if (!lawFirmId) throw new Error('Law firm ID is required');
      const updated = await rolesService.updateRole(lawFirmId, roleId, data);
      await invalidate();
      return updated;
    },
    [lawFirmId, invalidate],
  );

  const deleteRole = useCallback(
    async (roleId: string) => {
      if (!lawFirmId) throw new Error('Law firm ID is required');
      await rolesService.deleteRole(lawFirmId, roleId);
      await invalidate();
    },
    [lawFirmId, invalidate],
  );

  return useMemo(
    () => ({
      roles: roles ?? [],
      loading: isLoading,
      error: error ? (error instanceof Error ? error.message : 'Failed to load roles') : null,
      createRole,
      updateRole,
      deleteRole,
      refetch,
    }),
    [roles, isLoading, error, createRole, updateRole, deleteRole, refetch],
  );
}

export default useRoles;
