/**
 * Centralized token refresh handler for expired tokens
 * This module handles 401 errors globally and forces a page refresh once
 */

let hasRefreshed = false;
let refreshPromise: Promise<void> | null = null;

/**
 * Handles expired token by forcing a page refresh once
 * @param error - The error that occurred
 * @returns Promise that resolves when refresh is complete
 */
export async function handleExpiredToken(error: any): Promise<void> {
  // If we've already refreshed once, don't refresh again
  if (hasRefreshed) {
    throw error;
  }

  // If there's already a refresh in progress, wait for it
  if (refreshPromise) {
    await refreshPromise;
    return;
  }

  // Create the refresh promise
  refreshPromise = (async () => {
    try {
      hasRefreshed = true;
      
      // Force refresh the page
      window.location.reload();
    } catch (refreshError) {
      console.error('❌ Failed to refresh page:', refreshError);
      throw refreshError;
    }
  })();

  return refreshPromise;
}

/**
 * Resets the refresh state. Only the test suite calls this: in the browser
 * `handleExpiredToken` reloads the page, which resets the module anyway.
 */
export function resetRefreshState(): void {
  hasRefreshed = false;
  refreshPromise = null;
}
