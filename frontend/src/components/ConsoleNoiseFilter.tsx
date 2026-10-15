"use client";

import React, { useEffect } from 'react';

// Suppresses a small set of expected, non-actionable auth console messages
// (transient OAuth token-refresh failures and a blocked-popup notice) so they
// don't drown out real warnings/errors during development.
const ConsoleNoiseFilter: React.FC = () => {
  useEffect(() => {
    const originalWarn = console.warn;
    const originalError = console.error;

    const filterMessage = (message: string) => {
      const str = String(message);
      return (
        str.includes('Failed to refresh Microsoft token') ||
        str.includes('Failed to re-authenticate with Google') ||
        str.includes('Google sign-in popup was blocked')
      );
    };

    console.warn = (...args) => {
      const message = args.join(' ');
      if (filterMessage(message)) {
        return;
      }
      originalWarn.apply(console, args);
    };

    console.error = (...args) => {
      const message = args.join(' ');
      if (filterMessage(message)) {
        return;
      }
      originalError.apply(console, args);
    };

    return () => {
      console.warn = originalWarn;
      console.error = originalError;
    };
  }, []);

  return null;
};

export default ConsoleNoiseFilter;
