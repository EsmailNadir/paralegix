"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

/** Connect submission errors to their field, or focus the general error summary. */
export default function useFormFeedback() {
  const [feedback, setFeedback] = useState({ message: "", field: "" });
  const formRef = useRef<HTMLFormElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const feedbackId = useId();
  const setErrorMessage = useCallback((message: string) => {
    setFeedback({ message, field: "" });
  }, []);
  const setFieldError = useCallback((field: string, message: string) => {
    setFeedback({ message, field });
  }, []);

  useEffect(() => {
    if (!feedback.message) return;
    const field = formRef.current?.elements.namedItem(feedback.field);
    if (field instanceof HTMLElement) field.focus();
    else feedbackRef.current?.focus();
  }, [feedback]);

  return {
    errorMessage: feedback.message,
    invalidField: feedback.field,
    setErrorMessage,
    setFieldError,
    formRef,
    feedbackRef,
    feedbackId,
  };
}
