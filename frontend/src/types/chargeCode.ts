export type ChargeCode = {
  id: string;
  lawFirmId: string;
  code: string;
  name: string;
  isActive: boolean;
  order: number;
  defaultRate?: number | null;
  memberRates?: Record<string, number>;
  createdAt?: string | null;
  updatedAt?: string | null;
  createdBy: string;
};
