/**
 * USER_NAME_UPDATED no longer needs a handler here: member names are resolved
 * via a JOIN to the users table at read time (members no longer store a name
 * copy), so there is no denormalized name to sync. The legacy cascade has been
 * removed.
 */
