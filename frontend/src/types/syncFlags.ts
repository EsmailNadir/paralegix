import type { CalendarConnectionState } from '@/types/preferences';

export type SyncFlags = {
  googleCalendarState?: CalendarConnectionState;
  microsoftCalendarState?: CalendarConnectionState;
  loggedInWithGoogle?: boolean;
  loggedInWithMicrosoft?: boolean;
  allowOutlookToParalegixSync?: boolean;
  allowParalegixToOutlookSync?: boolean;
  allowParalegixToGoogleSync?: boolean;
  allowGoogleToParalegixSync?: boolean;
};
