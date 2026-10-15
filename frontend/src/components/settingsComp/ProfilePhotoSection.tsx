"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Avatar from "@/components/ui/Avatar";
import Button from "@/components/ui/Button";
import SuccessNotification from "@/components/SuccessNotification";
import ConfirmModal from "@/components/ui/ConfirmModal";
import ErrorNotification from "@/components/ErrorNotification";
import LogoCropModal from "@/components/settingsComp/LogoCropModal";
import userService from "@/services/users.service";
import { useProfile } from "@/contexts/ProfileContext";
import useFormFeedback from "@/hooks/useFormFeedback";

const ALLOWED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
const MAX_SIZE_BYTES = 5 * 1024 * 1024;
const INVALID_TYPE_MESSAGE = "Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed.";
const OVERSIZE_MESSAGE = "File size must be less than 5MB.";

/**
 * Self-contained profile-picture card: shows the current avatar with Change/Remove
 * controls, a crop step, and a delete confirmation. Loads and mutates the signed-in
 * user's own photo via the users service, so it drops into any settings page (firm
 * member or client portal) without extra wiring.
 */
export default function ProfilePhotoSection() {
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cropObjectUrlRef = useRef<string | null>(null);
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  const deleteFeedbackRef = useRef<HTMLDivElement>(null);
  const wasDeleteOpenRef = useRef(false);

  // The signed-in profile is fetched once by the surrounding layout and shared
  // via ProfileContext; name/email come from it directly, and the avatar seeds
  // from it (local upload/delete below then overrides the photo).
  const { profile } = useProfile();
  const name = profile?.name ?? null;
  const email = profile?.email ?? null;
  const [photoUrl, setPhotoUrl] = useState<string | null>(profile?.photoUrl ?? null);

  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { errorMessage: error, setErrorMessage: setError, feedbackRef, feedbackId } = useFormFeedback();
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [cropSource, setCropSource] = useState<string | null>(null);
  const [cropFileName, setCropFileName] = useState("");
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  // Only a refused file describes the chooser; a removal or upload failure left
  // on the page says nothing about the file the user picks next.
  const fileError = (error === INVALID_TYPE_MESSAGE || error === OVERSIZE_MESSAGE) && !cropSource && !showDeleteModal;

  useEffect(() => {
    if (wasDeleteOpenRef.current && !showDeleteModal && !photoUrl) changeButtonRef.current?.focus();
    wasDeleteOpenRef.current = showDeleteModal;
  }, [photoUrl, showDeleteModal]);

  useEffect(() => {
    if (showDeleteModal && error && !deleting) deleteFeedbackRef.current?.focus();
  }, [deleting, error, showDeleteModal]);

  // Sync the avatar if the shared profile resolves after mount. The profile
  // doesn't change again after load, so local upload/delete edits aren't clobbered.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors the shared profile photo into local state seeded once at mount
    setPhotoUrl(profile?.photoUrl ?? null);
  }, [profile?.photoUrl]);

  const clearCropper = useCallback(() => {
    if (cropObjectUrlRef.current) {
      URL.revokeObjectURL(cropObjectUrlRef.current);
      cropObjectUrlRef.current = null;
    }
    setCropSource(null);
    setCropFileName("");
    if (photoInputRef.current) {
      photoInputRef.current.value = "";
    }
  }, []);

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      setError(INVALID_TYPE_MESSAGE);
      e.target.value = "";
      return;
    }

    if (file.size > MAX_SIZE_BYTES) {
      setError(OVERSIZE_MESSAGE);
      e.target.value = "";
      return;
    }

    clearCropper();
    setError('');
    setSuccessMessage(null);

    const objectUrl = URL.createObjectURL(file);
    cropObjectUrlRef.current = objectUrl;
    setCropSource(objectUrl);
    setCropFileName(file.name);
    e.target.value = "";
  };

  const handleCroppedUpload = useCallback(
    async (file: File) => {
      try {
        setUploading(true);
        setError('');
        setSuccessMessage(null);

        const { photoUrl: nextUrl } = await userService.setPhoto(file);
        setPhotoUrl(nextUrl ?? null);
        setSuccessMessage("Profile picture updated successfully!");
        setTimeout(() => setSuccessMessage(null), 3000);
        clearCropper();
      } catch (e) {
        // Keep the crop modal open so the user can retry.
        setError(e instanceof Error ? e.message : "Failed to upload profile picture");
      } finally {
        setUploading(false);
      }
    },
    [clearCropper, setError],
  );

  const handlePhotoDelete = async () => {
    try {
      setDeleting(true);
      setError('');
      setSuccessMessage(null);

      await userService.deletePhoto();
      setPhotoUrl(null);
      setShowDeleteModal(false);
      setSuccessMessage("Profile picture removed successfully!");
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove profile picture");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="bg-surface rounded-2xl border border-outline-subtle p-5">
      <p className="text-sm font-medium text-on-surface">Profile Picture</p>
      <p className="text-xs text-on-surface-muted mt-1">
        Add a photo so people recognize you. It appears next to your name across the portal.
      </p>

      <div className="mt-4">
        {!cropSource && !showDeleteModal && (
          <div ref={feedbackRef} id={feedbackId} tabIndex={-1}>
            <ErrorNotification error={error} onClose={() => { setError(''); changeButtonRef.current?.focus(); }} />
          </div>
        )}
      </div>

      <SuccessNotification message={successMessage} className="mt-2" />

      <div className="mt-4 flex items-center gap-4">
        <Avatar size="lg" photoUrl={photoUrl} name={name} email={email} />
        <div className="flex flex-wrap gap-2">
          <input
            ref={photoInputRef}
            type="file"
            aria-label="Choose profile picture"
            accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
            onChange={handlePhotoSelect}
            aria-invalid={fileError || undefined}
            aria-describedby={fileError ? feedbackId : undefined}
            disabled={uploading}
            className="hidden"
          />
          <Button
            ref={changeButtonRef}
            type="secondary"
            size="small"
            disabled={uploading}
            aria-describedby={fileError ? feedbackId : undefined}
            onClick={() => photoInputRef.current?.click()}
          >
            {uploading ? "Uploading..." : "Change photo"}
          </Button>
          {photoUrl && (
            <Button
              type="secondary"
              size="small"
              onClick={() => { setError(''); setShowDeleteModal(true); }}
              disabled={deleting}
              className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-500/30 dark:hover:bg-red-500/10"
            >
              {deleting ? "Removing..." : "Remove"}
            </Button>
          )}
        </div>
      </div>

      <LogoCropModal
        isOpen={!!cropSource}
        imageSrc={cropSource}
        fileName={cropFileName}
        loading={uploading}
        error={error}
        title="Crop Profile Picture"
        description="Drag the crop box or pull its corners to frame your photo."
        confirmText="Crop & Save"
        onClose={clearCropper}
        onConfirm={handleCroppedUpload}
      />

      <ConfirmModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={handlePhotoDelete}
        loading={deleting}
        title="Remove Profile Picture"
        message="Are you sure you want to remove your profile picture? Your avatar will fall back to your initials."
        confirmText="Remove"
        extra={error ? <div ref={deleteFeedbackRef} tabIndex={-1}><ErrorNotification error={error} /></div> : undefined}
      />
    </div>
  );
}
