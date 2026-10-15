'use client';

import { createContext, useContext } from 'react';
import type { User } from '@/types';

interface ProfileContextValue {
  // The signed-in user's own profile, fetched once by the firm/client layout's
  // userType guard and shared so the sidebar avatar and settings pages don't each
  // issue their own /users/profile request.
  profile: User | null;
}

export const ProfileContext = createContext<ProfileContextValue>({ profile: null });

export function useProfile() {
  return useContext(ProfileContext);
}
