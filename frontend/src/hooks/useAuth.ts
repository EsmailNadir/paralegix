import { useState, useEffect } from 'react';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';

export function useAuth() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Only run on client side
    if (typeof window === 'undefined') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- effect subscribes to firebase onAuthStateChanged (with a timeout fallback) and syncs auth state asynchronously
      setLoading(false);
      return;
    }

    // Safety: stop loading after 10s if Firebase never responds (e.g. network issues)
    const fallback = setTimeout(() => setLoading(false), 10000);

    const initAuth = async () => {
      try {
        const { auth } = await import('@/lib/firebase/config');
        if (!auth) {
          clearTimeout(fallback);
          setLoading(false);
          return undefined;
        }

        const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
          clearTimeout(fallback);
          setUser(firebaseUser);
          setLoading(false);
        });

        return unsubscribe;
      } catch (error) {
        console.error('Error initializing auth:', error);
        clearTimeout(fallback);
        setLoading(false);
        return undefined;
      }
    };

    const unsubscribePromise = initAuth();

    return () => {
      clearTimeout(fallback);
      unsubscribePromise.then(unsubscribe => {
        if (unsubscribe) unsubscribe();
      });
    };
  }, []);

  return { user, loading };
}
