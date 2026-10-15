
export type User = {
  uid: string;
  email: string;
  name: string;
  userType: 'client' | 'firm_member' | 'pending';
  photoUrl?: string | null;
  isAdmin?: boolean;
  role?: string;
  lawFirmIds?: string[];
  clientLawFirmIds?: string[];
  createdAt?: string | null;
  updatedAt?: string | null;
  defaultHourlyRate?: number | null;
  provider?: string;
};
