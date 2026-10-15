"use client";

import { useState } from "react";
import { getErrorMessage } from "@/lib/utils/apiErrors";

/** A rejected save leaves the entered name available for correction and retry. */
export default function useNamePrompt(initialName = "") {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (action: () => Promise<void>, failureMessage: string) => {
    setSaving(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(getErrorMessage(err, failureMessage));
    } finally {
      setSaving(false);
    }
  };
  return { name, setName, error, setError, saving, save };
}
