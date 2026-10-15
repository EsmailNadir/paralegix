"use client";

import { useEffect, useId, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import ErrorNotification from "@/components/ErrorNotification";
import SuccessNotification from "@/components/SuccessNotification";
import AuthService from "@/services/auth.service";
import { useAuth } from "@/hooks/useAuth";
import { useProfile } from "@/contexts/ProfileContext";
import FieldLabel from "@/components/ui/FieldLabel";
import useFormFeedback from "@/hooks/useFormFeedback";
import TextInput from "@/components/ui/TextInput";

/**
 * Self-contained display-name card: shows the signed-in user's name and (read-only)
 * email with an edit toggle. Like ProfilePhotoSection it mutates only the caller's
 * own account, so it drops into any settings page - firm member or client portal - 
 * without extra wiring.
 */
export default function ProfileNameSection() {
  const { user } = useAuth();
  const { profile } = useProfile();

  // The stored profile name is what colleagues and clients actually see (every
  // roster, message and assignment reads it from the users table), so it wins
  // over the Firebase display name, which is only a mirror of it.
  const storedName = profile?.name || user?.displayName || "";
  const email = profile?.email || user?.email || "";

  const [currentName, setCurrentName] = useState(storedName);
  const [newName, setNewName] = useState(storedName);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const { errorMessage: error, setErrorMessage: setError, setFieldError, invalidField, formRef, feedbackRef, feedbackId } = useFormFeedback();
  const editorId = useId();
  const nameInputRef = useRef<HTMLInputElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const lastStoredName = useRef(storedName);
  const [success, setSuccess] = useState<string | null>(null);

  // Adopt new profile values without overwriting edits or reapplying an unchanged
  // profile snapshot after a local save.
  useEffect(() => {
    if (editing || lastStoredName.current === storedName) return;
    lastStoredName.current = storedName;
    setCurrentName(storedName);
    setNewName(storedName);
  }, [storedName, editing]);

  useEffect(() => {
    if (editing) nameInputRef.current?.focus();
    else if (wasEditing.current) editButtonRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const trimmed = newName.trim();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!trimmed) {
      setFieldError("name", "Name cannot be empty");
      return;
    }
    if (trimmed === currentName) {
      setFieldError("name", "New name must be different from your current name");
      return;
    }

    try {
      setSaving(true);
      setError("");
      await AuthService.updateName(trimmed);
      setCurrentName(trimmed);
      setEditing(false);
      setSuccess("Name updated successfully!");
      setTimeout(() => setSuccess(null), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update name");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-surface rounded-2xl border border-outline-subtle p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-on-surface">Your Name</p>
          <p className="text-xs text-on-surface-muted mt-1">
            This is the name shown to your colleagues and clients.
          </p>
        </div>
        <Button
          type="secondary"
          size="small"
          className="w-full md:w-auto shrink-0"
          ref={editButtonRef}
          aria-expanded={editing}
          aria-controls={editing ? editorId : undefined}
          onClick={() => {
            setError("");
            setNewName(currentName);
            setEditing((v) => !v);
          }}
        >
          {editing ? "Cancel" : "Edit"}
        </Button>
      </div>

      <SuccessNotification message={success} className="mt-3" />

      {editing ? (
        <form ref={formRef} id={editorId} onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <FieldLabel htmlFor="profileName">
              Name *
            </FieldLabel>
            <TextInput
              id="profileName"
              name="name"
              ref={nameInputRef}
              aria-invalid={invalidField === "name"}
              aria-describedby={`${editorId}-hint${invalidField === "name" ? ` ${feedbackId}` : ""}`}
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Enter your name"
              maxLength={100}
              required
            />
            <p id={`${editorId}-hint`} className="text-xs text-on-surface-muted mt-1">Maximum 100 characters.</p>
          </div>

          {error && (
            <div id={feedbackId} ref={feedbackRef} tabIndex={-1}>
              <ErrorNotification error={error} onClose={() => setError("")} compact />
            </div>
          )}

          <Button
            type="primary"
            size="small"
            loading={saving}
            disabled={saving || !trimmed || trimmed === currentName}
            htmlType="submit"
          >
            Update Name
          </Button>
        </form>
      ) : (
        <div className="mt-4 space-y-2 text-sm">
          <div>
            <span className="font-medium text-on-surface">Name:</span>{" "}
            <span className="text-on-surface-secondary">{currentName || "Not set"}</span>
          </div>
          {email && (
            <div>
              <span className="font-medium text-on-surface">Email:</span>{" "}
              <span className="text-on-surface-secondary">{email}</span>
            </div>
          )}
          <p className="text-xs text-on-surface-muted">Your email address cannot be changed.</p>
        </div>
      )}
    </div>
  );
}
