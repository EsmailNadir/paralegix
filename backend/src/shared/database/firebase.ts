const { initializeApp, getApps, cert, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');

if (!getApps().length) {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY));
  } else {
    try {
      const serviceAccount = require('../../../serviceAccountKey.json');
      credential = cert(serviceAccount);
    } catch (error: any) {
      if (error.code !== 'MODULE_NOT_FOUND') {
        throw error;
      }
      // Cloud Build / Cloud Run can use the attached service account via ADC.
      credential = applicationDefault();
    }
  }

  initializeApp({
    credential,
    // Default must match the BUCKET_NAME used across every storage module
    // (files, matters, tasks, signatures, etc.) Use 'lawfirms', not 'lawfirm',
    // so code relying on the firebase-init default hits the same bucket.
    storageBucket: process.env.GCS_BUCKET || 'lawfirms',
  });
}

export const auth = getAuth();

// firebase-admin v14 removed the namespaced `admin.*` accessors in favour of the
// modular entry points. This `admin` object preserves the `admin.auth()` /
// `admin.storage()` call shape used across the storage modules without forcing a
// rewrite of every call site.
export const admin = {
  auth: getAuth,
  storage: getStorage,
};

// NOTE: All data access is Postgres (Supabase). Firebase is retained ONLY for
// Auth (`auth`) and, via `admin`, GCS storage (`admin.storage()`). The codebase
// no longer touches Firestore at all. Timestamps are native Postgres
// timestamptz values returned as ISO strings, never Firestore Timestamp objects.
// This module is Auth and GCS storage only. Data access goes through Postgres.
