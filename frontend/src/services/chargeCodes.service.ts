import { ChargeCode } from '../types/chargeCode';
import billingService from './billing.service';

class ChargeCodesService {
  async createChargeCode(lawFirmId: string, chargeCodeData: {
    code: string;
    name: string;
    defaultRate?: number | null;
    memberRates?: Record<string, number>;
  }): Promise<{ message: string; chargeCodeId: string }> {
    return billingService.createChargeCode(lawFirmId, chargeCodeData);
  }

  async updateChargeCode(
    chargeCodeId: string,
    lawFirmId: string,
    chargeCodeData: {
      code?: string;
      name?: string;
      isActive?: boolean;
      defaultRate?: number | null;
      memberRates?: Record<string, number>;
    }
  ): Promise<{ message: string }> {
    return billingService.updateChargeCode(lawFirmId, chargeCodeId, chargeCodeData);
  }

  async getChargeCode(chargeCodeId: string, lawFirmId: string): Promise<ChargeCode> {
    return billingService.getChargeCode(lawFirmId, chargeCodeId);
  }

  async getChargeCodes(lawFirmId: string, includeInactive: boolean = false): Promise<{ chargeCodes: ChargeCode[] }> {
    return billingService.getChargeCodes(lawFirmId, includeInactive);
  }

  async deleteChargeCode(chargeCodeId: string, lawFirmId: string): Promise<{ message: string }> {
    return billingService.deleteChargeCode(lawFirmId, chargeCodeId);
  }

  async reorderChargeCodes(lawFirmId: string, chargeCodeIds: string[]): Promise<{ message: string }> {
    return billingService.reorderChargeCodes(lawFirmId, chargeCodeIds);
  }
}

export const chargeCodesService = new ChargeCodesService();
