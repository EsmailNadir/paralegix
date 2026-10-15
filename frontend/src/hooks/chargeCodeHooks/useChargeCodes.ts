import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { chargeCodesService } from '../../services/chargeCodes.service';
import { ChargeCode } from '../../types/chargeCode';
import { usePermissions } from '../../contexts/PermissionsContext';

/**
 * Firm charge codes.
 *
 * `enabled` lets an always-mounted caller hold the request back until the UI that
 * needs the codes is actually on screen. The cache key is unchanged, so a gated
 * caller still shares one cache entry with the ungated ones.
 *
 * The list route needs `billing.viewRates`, which is not part of the member
 * baseline. A member without it (a time-entry modal is still open to someone who
 * can only log time) gets an empty list and no request, rather than a 403 shown
 * as an error. Callers that draw a picker should hide it while the list is empty
 * for that reason.
 */
export default function useChargeCodes(
  lawFirmId?: string,
  includeInactive: boolean = false,
  enabled: boolean = true,
) {
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const canViewRates = hasPermission('billing.viewRates');

  const { data, isLoading, error, refetch } = useQuery<{ chargeCodes: ChargeCode[] }>({
    queryKey: ['chargeCodes', lawFirmId, includeInactive],
    queryFn: () => chargeCodesService.getChargeCodes(lawFirmId!, includeInactive),
    enabled: enabled && !!lawFirmId && canViewRates,
  });

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['chargeCodes', lawFirmId] }),
    [queryClient, lawFirmId],
  );

  const createChargeCode = async (chargeCodeData: {
    code: string;
    name: string;
    defaultRate?: number | null;
  }) => {
    if (!lawFirmId) throw new Error('Law firm ID is required');
    const response = await chargeCodesService.createChargeCode(lawFirmId, chargeCodeData);
    await invalidate();
    return response;
  };

  const updateChargeCode = async (
    chargeCodeId: string,
    chargeCodeData: {
      code: string;
      name: string;
      isActive?: boolean;
    }
  ) => {
    if (!lawFirmId) throw new Error('Law firm ID is required');
    const response = await chargeCodesService.updateChargeCode(chargeCodeId, lawFirmId, chargeCodeData);
    await invalidate();
    return response;
  };

  const deleteChargeCode = async (chargeCodeId: string) => {
    if (!lawFirmId) throw new Error('Law firm ID is required');
    const response = await chargeCodesService.deleteChargeCode(chargeCodeId, lawFirmId);
    await invalidate();
    return response;
  };

  const reorderChargeCodes = async (chargeCodeIds: string[]) => {
    if (!lawFirmId) throw new Error('Law firm ID is required');
    const response = await chargeCodesService.reorderChargeCodes(lawFirmId, chargeCodeIds);
    await invalidate();
    return response;
  };

  return {
    chargeCodes: data?.chargeCodes ?? [],
    loading: isLoading,
    error: error ? (error instanceof Error ? error.message : 'Failed to fetch charge codes') : null,
    createChargeCode,
    updateChargeCode,
    deleteChargeCode,
    reorderChargeCodes,
    refetch,
  };
}
