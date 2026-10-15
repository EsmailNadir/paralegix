import type { ApiClient } from './client';

/** What one virtual user has created so far, so later iterations reuse it. */
export interface VuState {
  matterId: string | null;
  docxTemplateId: string | null;
  htmlTemplateId: string | null;
}

export interface Vu {
  index: number;
  uid: string;
  lawFirmId: string;
  api: ApiClient;
  state: VuState;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The pause between screens: two to six seconds, about how long a person reads one. */
export const think = () => sleep(2000 + Math.random() * 4000);
