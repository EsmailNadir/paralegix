const usersRepo = require('./users.repository');
const eventBus = require('../../shared/events/eventBus');
const { USER_NAME_UPDATED } = require('../../shared/events/eventTypes');
const { NotFoundError } = require('../../shared/errors/AppError');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { admin } = require('../../shared/database/firebase');
const {
  signUserPhotoUrl, deleteUserPhotoObjects, userPhotoPrefix, BUCKET_NAME,
} = require('../../shared/utils/userPhoto');
import { beginDirectUpload, settleDirectUpload } from '../../shared/storage/directUpload';
import { AppError } from '../../shared/errors/AppError';

// A conditional GET that matches replays the *stored* body, and that body holds
// the photo's signed URL, which expires. Rolling the tag on this interval bounds
// how old a replayed URL can be; without it a profile row that never changes
// would keep its tag forever and eventually hand back an expired link, making
// the avatar silently vanish. Must stay well under the signed-URL lifetime.
const PHOTO_ETAG_INTERVAL_MS = 1000 * 60 * 60 * 24; // 1 day

function withEtag(prefix: any, user: any) {
  const t = user.updatedAt ? Date.parse(user.updatedAt)
    : user.createdAt ? Date.parse(user.createdAt) : Date.now();
  const photo = user.photoUrl ? `-p${Math.floor(Date.now() / PHOTO_ETAG_INTERVAL_MS)}` : '';
  return {
    userData: user,
    etag: `"${prefix}-${user.id}-${t}${photo}"`,
    lastModified: new Date(t).toUTCString(),
  };
}

/** Attach the signed avatar URL, keeping the raw GCS path server-side. */
async function attachPhotoUrl(user: any) {
  // `updatedAt` is the content version: an avatar re-upload bumps the row, so
  // every instance recomputes the cache key rather than serving a stale URL.
  user.photoUrl = await signUserPhotoUrl(user.photoObjectPath, user.updatedAt);
  delete user.photoObjectPath;
  return user;
}

/**
 * Every user account on the platform, for the admin-only `/users` read.
 *
 * Bounded: `truncated` says the ceiling cut the list short and `ceiling` says
 * where, so a capped list is not read as the whole platform. `/api/admin/users`
 * is the paged, searchable version of this list.
 */
export async function listAllUsers() {
  const { users, truncated, ceiling } = await usersRepo.findAllCapped();
  return { users, totalItems: users.length, truncated, ceiling };
}

export async function getProfile({ userId }: any) {
  const user = await usersRepo.findById(userId);
  if (!user) throw new NotFoundError('User');
  await attachPhotoUrl(user);
  return withEtag('user-profile', user);
}

export async function getMyLawFirms({ userId }: any) {
  await usersRepo.findByIdOrFail(userId);
  const lawFirmIds = await usersRepo.getLawFirmIdsForUser(userId);
  return { lawFirmIds };
}

/**
 * The caller's own firm memberships with the firm name, their role, and whether
 * they own the firm. Unlike `getMyLawFirms` this needs no per-firm follow-up
 * request, so the account page can list every firm the user belongs to — and
 * tell which ones they may leave — in one round trip.
 */
export async function getMyMemberships({ userId }: any) {
  await usersRepo.findByIdOrFail(userId);
  const memberships = await usersRepo.getMemberships(userId);
  return { memberships };
}

export async function getLawFirmUsers({ lawFirmId, requesterId }: any) {
  // The firm roster (names, emails, roles, internal hourly rates) is firm-private.
  // Require the caller to be a member of this firm so it can't be read cross-tenant
  // by iterating firm ids. Throws ForbiddenError for non-members.
  await assertLawFirmMembership(lawFirmId, requesterId);
  const members = await usersRepo.getLawFirmMembers(lawFirmId);
  await Promise.all(members.map(attachPhotoUrl));
  return members;
}

export async function getUserById({ userId, requesterId }: any) {
  const user = await usersRepo.findById(userId);
  if (!user) throw new NotFoundError('User');
  if (requesterId !== userId) {
    // A profile is only readable by its owner, by a firm member who shares a firm
    // with the target, or by a client reading a firm member (their legal team).
    // A client CANNOT read another client's profile — otherwise a client could
    // take a co-client's UID from a group-conversation payload and look up the
    // real name/email, defeating the firm's "hide client names" setting. Return
    // the same not-found error to everyone else so a bare UID can't be used to
    // read strangers' details or confirm an account exists.
    const canRead = await usersRepo.canReadProfile(requesterId, userId);
    if (!canRead) throw new NotFoundError('User');
    // Don't disclose platform-admin status or internal identifiers to anyone other
    // than the account owner, so a UID can't be used to enumerate super-admins.
    delete user.isAdmin;
  }
  await attachPhotoUrl(user);
  return withEtag('user', user);
}

export async function updateName({ userId, body }: any) {
  const trimmedName = body.name.trim();
  await usersRepo.findByIdOrFail(userId);
  await usersRepo.update(userId, { name: trimmedName });

  // Name is no longer denormalized. Nothing to propagate. The event is kept
  // for any non-denormalization listeners.
  const lawFirmIds = await usersRepo.getLawFirmIdsForUser(userId);
  eventBus.emit(USER_NAME_UPDATED, { userId, name: trimmedName, lawFirmIds });

  return { message: 'Name updated successfully', name: trimmedName };
}

/**
 * Image types a profile picture may be.
 *
 * Enforced at both ends of the upload. The type declared when the session opens
 * is a claim by the caller; the resumable URL enforces nothing, so what storage
 * actually recorded is checked again before the picture is saved.
 */
export const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Largest profile picture. Unchanged by the move to direct upload: going direct
 * removes the buffering, not the limit.
 */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** File extension for a stored picture, from the type rather than the name. */
const EXTENSION_FOR: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
};

/**
 * Open a direct upload for the caller's own profile picture.
 *
 * The picture used to arrive as multipart and sit in the container's heap
 * before this ran. The bytes now go from the browser to storage; this only
 * decides where they land and what is allowed.
 *
 * The extension comes from the CONTENT TYPE, never from the submitted file
 * name. A name is caller-controlled and reaches an object path, so taking the
 * extension from it is how a path escapes the avatar folder.
 */
export async function beginPhotoUpload({ userId, contentType, fileName, size, origin }: any) {
  await usersRepo.findByIdOrFail(userId);
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  const ext = EXTENSION_FOR[type];
  if (!ext) {
    throw new AppError(
      'Invalid file type. Only JPEG, PNG, GIF, or WebP allowed.', 415, 'FILE_TYPE_NOT_ALLOWED',
    );
  }
  const objectPath = `${userPhotoPrefix(userId)}avatar.${ext}`;
  return beginDirectUpload({
    objectPath,
    contentType: type,
    uploadedBy: userId,
    maxBytes: MAX_PHOTO_BYTES,
    allowedContentTypes: ALLOWED_PHOTO_TYPES,
    fileName: fileName || `avatar.${ext}`,
    declaredSize: Number(size) || undefined,
    origin,
    metadata: { cacheControl: 'private, max-age=0, no-transform' },
  });
}

/**
 * Save the picture the browser uploaded.
 *
 * `objectPath` arrives from the client, so it is checked against the caller's
 * own avatar folder before anything else. Without that the row could be pointed
 * at any object in the bucket, and the signed URL this returns would hand it
 * over.
 */
export async function finishPhotoUpload({ userId, objectPath }: any) {
  await usersRepo.findByIdOrFail(userId);
  const prefix = userPhotoPrefix(userId);
  const path = String(objectPath || '');
  if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) {
    throw new AppError('That upload does not belong to your profile.', 400, 'VALIDATION');
  }

  await settleDirectUpload({
    objectPath: path,
    uploadedBy: userId,
    maxBytes: MAX_PHOTO_BYTES,
    allowedContentTypes: ALLOWED_PHOTO_TYPES,
    fileName: 'avatar',
  });

  await usersRepo.update(userId, { photoObjectPath: path });
  // Drops avatars left at other extensions by earlier uploads, and every cached
  // signed URL under the folder. A re-upload reuses the same path, so without
  // that invalidation the stale URL comes back and the browser keeps serving the
  // previous image.
  await deleteUserPhotoObjects(userId, { except: path });
  // Version by upload time so this response, and every other instance's next
  // read, key on something the re-upload changed.
  return { message: 'Profile picture updated', photoUrl: await signUserPhotoUrl(path, Date.now()) };
}

export async function deletePhoto({ userId }: any) {
  await usersRepo.findByIdOrFail(userId);
  await deleteUserPhotoObjects(userId);
  await usersRepo.update(userId, { photoObjectPath: null });
  return { message: 'Profile picture removed' };
}
