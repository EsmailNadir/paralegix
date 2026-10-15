'use client';
import { useState } from 'react';
import { getInitials } from '@/lib/utils/format';

/** Safe initials: tolerates empty/one-word names, and falls back to the email's local part. */
function initialsOf(name?: string | null, email?: string | null): string {
  const src = (name && name.trim()) || (email && email.split('@')[0]) || '';
  return getInitials(src);
}

const SIZES = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-16 w-16 text-lg',
} as const;

export interface AvatarProps {
  name?: string | null;
  email?: string | null;
  photoUrl?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
  // How the image fills the circle. 'cover' (default) crops to fill - right for
  // square user photos. 'contain' shows the whole image letterboxed on a light
  // chip - use for logos/wordmarks that must not be cropped in half.
  fit?: 'cover' | 'contain';
}

export function Avatar({ name, email, photoUrl, size = 'md', className = '', fit = 'cover' }: AvatarProps) {
  const [broken, setBroken] = useState(false);
  // Reset the broken flag whenever the photo URL changes, so a fresh upload (or a
  // new signed URL) is attempted instead of staying stuck on the initials
  // fallback from a previously-failed load. Adjusts state during render (React's
  // documented pattern), which is correct here - no effect needed.
  const [lastUrl, setLastUrl] = useState(photoUrl);
  if (photoUrl !== lastUrl) {
    setLastUrl(photoUrl);
    setBroken(false);
  }
  const base = `inline-flex items-center justify-center rounded-full overflow-hidden shrink-0 ${SIZES[size]} ${className}`;
  if (photoUrl && !broken) {
    // 'contain' sits the logo on a white chip (with a little padding) so a
    // transparent or dark-ink wordmark stays visible and isn't cropped.
    return (
      // eslint-disable-next-line @next/next/no-img-element -- photoUrl is a short-lived signed GCS URL, so next/image's optimizer (which needs a stable, allow-listed remote host) cannot serve it
      <img
        src={photoUrl}
        alt={name || email || 'User'}
        className={`${base} ${fit === 'contain' ? 'object-contain bg-white p-0.5' : 'object-cover'}`}
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span
      className={`${base} bg-accent-soft text-accent-emphasis dark:text-accent-emphasis font-semibold`}
      aria-label={name || email || 'User'}
    >
      {initialsOf(name, email)}
    </span>
  );
}

export default Avatar;
