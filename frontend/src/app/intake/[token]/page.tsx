"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { AlertCircle, CheckCircle2, ClipboardList, Lock } from "lucide-react";
import LoadingSpinner from "@/components/LoadingSpinner";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import FieldError from "@/components/ui/FieldError";
import ErrorNotification from "@/components/ErrorNotification";
import leadsService from "@/services/leads.service";
import { ApiError, getErrorMessage } from "@/lib/utils/apiErrors";
import type { IntakeFormField } from "@/types";
import FieldLabel from "@/components/ui/FieldLabel";
import { FULL_INPUT_CLS } from "@/components/ui/inputClasses";
import useFormFeedback from "@/hooks/useFormFeedback";

type LoadState =
  | "loading"
  | "ready"
  | "needs_code"
  | "already_completed"
  | "submitted"
  | "not_found"
  | "error";

interface FormPayload {
  name: string;
  lawFirmName?: string | null;
  fields: IntakeFormField[];
  prefill?: { name?: string | null; email?: string | null } | null;
}


function MessageCard({
  title,
  message,
  icon,
  headingId,
}: {
  title: string;
  message: string;
  icon?: "alert" | "success" | "form";
  headingId?: string;
}) {
  const Icon =
    icon === "success" ? CheckCircle2 : icon === "form" ? ClipboardList : AlertCircle;
  return (
    <div className="w-full max-w-md rounded-xl bg-surface border border-outline shadow-sm p-8 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-alt">
        <Icon size={24} className="text-on-surface-muted" />
      </div>
      <h1 id={headingId} tabIndex={-1} className="text-lg font-semibold text-on-surface">{title}</h1>
      <p className="mt-2 text-sm text-on-surface-secondary">{message}</p>
    </div>
  );
}

export default function PublicIntakePage() {
  const params = useParams();
  const headingId = useId();
  const codeRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const token = (Array.isArray(params?.token) ? params.token[0] : params?.token) || "";

  const [state, setState] = useState<LoadState>("loading");
  const [formName, setFormName] = useState("");
  const [lawFirmName, setLawFirmName] = useState("");
  const [fields, setFields] = useState<IntakeFormField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [accessCode, setAccessCode] = useState("");
  const [verifiedCode, setVerifiedCode] = useState<string | undefined>(undefined);
  const [codeError, setCodeError] = useState<string | null>(null);
  const { errorMessage: submitError, setErrorMessage: setSubmitError, setFieldError, invalidField, formRef, feedbackRef, feedbackId } = useFormFeedback();
  const [submitting, setSubmitting] = useState(false);
  const [verifying, setVerifying] = useState(false);
  useEffect(() => {
    if (state !== 'loading' && state !== 'needs_code') document.getElementById(headingId)?.focus();
  }, [state, headingId]);
  useEffect(() => {
    if (codeError) codeRef.current?.focus();
  }, [codeError]);

  const applyPayload = useCallback((data: FormPayload) => {
    setFormName(data.name || "Intake form");
    setLawFirmName(data.lawFirmName || "");
    const nextFields = Array.isArray(data.fields) ? data.fields : [];
    setFields(nextFields);
    const initial: Record<string, string> = {};
    for (const field of nextFields) {
      if (!field.key) continue;
      const prefill = data.prefill;
      if (prefill) {
        const labelLower = (field.label || "").toLowerCase();
        if (
          (field.type === "email" || labelLower.includes("email") || field.key === "email") &&
          prefill.email
        ) {
          initial[field.key] = prefill.email;
          continue;
        }
        if (
          (field.type === "text" && (labelLower === "name" || field.key === "name")) &&
          prefill.name
        ) {
          initial[field.key] = prefill.name;
          continue;
        }
      }
      initial[field.key] = "";
    }
    setValues(initial);
    setState("ready");
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!token) {
        if (!cancelled) setState("not_found");
        return;
      }
      try {
        const data = await leadsService.getPublicIntakeForm(token);
        if (cancelled) return;
        if (data.alreadyCompleted) {
          setFormName(typeof data.name === "string" ? data.name : "Intake form");
          setLawFirmName(typeof data.lawFirmName === "string" ? data.lawFirmName : "");
          setState("already_completed");
          return;
        }
        if (data.requiresAccessCode) {
          setFormName(typeof data.name === "string" ? data.name : "Intake form");
          setLawFirmName(typeof data.lawFirmName === "string" ? data.lawFirmName : "");
          setState("needs_code");
          return;
        }
        applyPayload(data as unknown as FormPayload);
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setState("not_found");
        else setState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, applyPayload]);

  const handleVerifyCode = async () => {
    if (verifying) return;
    if (!accessCode.trim()) {
      setCodeError("Access code is required");
      return;
    }
    setVerifying(true);
    setCodeError(null);
    try {
      const data = await leadsService.verifyPublicIntakeAccessCode(token, accessCode.trim());
      if (data.alreadyCompleted) {
        setFormName(typeof data.name === "string" ? data.name : formName);
        setLawFirmName(typeof data.lawFirmName === "string" ? data.lawFirmName : lawFirmName);
        setState("already_completed");
        return;
      }
      setVerifiedCode(accessCode.trim());
      applyPayload(data as unknown as FormPayload);
    } catch (err) {
      setCodeError(getErrorMessage(err) || "Incorrect access code");
    } finally {
      setVerifying(false);
    }
  };

  const handleSubmit = async () => {
    if (submitting) return;
    for (const field of fields) {
      if (field.required && !(values[field.key] || '').trim()) {
        setFieldError(field.key, `${field.label} is required`);
        return;
      }
      const control = formRef.current?.elements.namedItem(field.key);
      if (control instanceof HTMLInputElement && !control.validity.valid) {
        setFieldError(field.key, field.type === 'email' ? 'Enter a valid email address' : `Check ${field.label.toLowerCase()}`);
        return;
      }
    }
    setSubmitting(true);
    setSubmitError('');
    try {
      await leadsService.submitPublicIntakeForm(token, {
        fieldValues: values,
        accessCode: verifiedCode,
      });
      setState("submitted");
    } catch (err) {
      setSubmitError(getErrorMessage(err) || "Failed to submit the form");
    } finally {
      setSubmitting(false);
    }
  };

  if (state === "loading") {
    return <LoadingSpinner />;
  }

  if (state === "not_found") {
    return (
      <MessageCard
        headingId={headingId}
        title="Form not available"
        message="This intake form does not exist or is no longer active. Ask the firm for a new link."
      />
    );
  }

  if (state === "error") {
    return (
      <MessageCard
        headingId={headingId}
        title="Something went wrong"
        message="We couldn't load this intake form. Please try again in a few minutes."
      />
    );
  }

  if (state === "already_completed") {
    return (
      <MessageCard
        headingId={headingId}
        title="Already submitted"
        message="You've already submitted this form. There's nothing else to do."
        icon="success"
      />
    );
  }

  if (state === "submitted") {
    return (
      <MessageCard
        headingId={headingId}
        title="Thanks, we'll be in touch"
        message="Your responses have been received. You can close this page."
        icon="success"
      />
    );
  }

  if (state === "needs_code") {
    return (
      <div className="w-full max-w-md rounded-xl bg-surface border border-outline shadow-sm p-8">
        <div className="flex flex-col items-center text-center mb-6">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-surface-alt">
            <Lock size={28} className="text-on-surface-secondary" />
          </div>
          {lawFirmName ? (
            <p className="text-xs font-medium uppercase tracking-wide text-on-surface-muted">
              {lawFirmName}
            </p>
          ) : null}
          <h1 className="text-lg font-semibold text-on-surface">{formName || "Intake form"}</h1>
          <p className="mt-1 text-sm text-on-surface-secondary">
            Enter the access code you were given to continue.
          </p>
        </div>
        <div>
          <FieldLabel htmlFor="intake-access-code">
            Access code *
          </FieldLabel>
          <input
            ref={codeRef}
            aria-invalid={!!codeError || undefined}
            aria-describedby={codeError ? `${headingId}-code-error` : undefined}
            id="intake-access-code"
            type="password"
            value={accessCode}
            onChange={(e) => {
              setAccessCode(e.target.value);
              if (codeError) setCodeError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleVerifyCode();
            }}
            className={FULL_INPUT_CLS}
            autoFocus
          />
          <div id={`${headingId}-code-error`}><FieldError message={codeError} /></div>
        </div>
        <div className="mt-6">
          <Button
            type="primary"
            onClick={handleVerifyCode}
            loading={verifying}
            disabled={verifying || !accessCode.trim()}
            className="w-full"
          >
            Continue
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form ref={formRef} noValidate onSubmit={(event) => { event.preventDefault(); void handleSubmit(); }} className="w-full max-w-lg rounded-xl bg-surface border border-outline shadow-sm p-8">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-surface-alt">
          <ClipboardList size={28} className="text-on-surface-secondary" />
        </div>
        {lawFirmName ? (
          <p className="text-xs font-medium uppercase tracking-wide text-on-surface-muted">
            {lawFirmName}
          </p>
        ) : null}
        <h1 id={headingId} tabIndex={-1} className="text-lg font-semibold text-on-surface">{formName}</h1>
        <p className="mt-1 text-sm text-on-surface-secondary">
          Please fill out the form below. Fields marked * are required.
        </p>
      </div>

      <div id={feedbackId} ref={feedbackRef} tabIndex={-1}>
        <ErrorNotification error={submitError} onClose={() => { setSubmitError(''); submitRef.current?.focus(); }} />
      </div>
      <div role="status" className="sr-only">{submitting ? 'Submitting your responses...' : ''}</div>

      <div className="space-y-4">
        {fields.map((field) => {
          if (!field.key) return null;
          const id = `intake-field-${field.key}`;
          const label = (
            <FieldLabel htmlFor={id}>
              {field.label}
              {field.required ? " *" : ""}
            </FieldLabel>
          );

          if (field.type === "textarea") {
            return (
              <div key={field.key}>
                {label}
                <textarea
                  name={field.key}
                  aria-invalid={invalidField === field.key || undefined}
                  aria-describedby={invalidField === field.key ? feedbackId : undefined}
                  id={id}
                  value={values[field.key] || ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                  className={`${FULL_INPUT_CLS} min-h-[96px] resize-y`}
                  rows={4}
                  required={field.required}
                />
              </div>
            );
          }

          if (field.type === "select") {
            return (
              <div key={field.key}>
                <Dropdown
                  name={field.key}
                  ariaRequired={field.required}
                  ariaInvalid={invalidField === field.key}
                  ariaDescribedBy={invalidField === field.key ? feedbackId : undefined}
                  label={`${field.label}${field.required ? " *" : ""}`}
                  value={values[field.key] || ""}
                  onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
                  options={[
                    { label: "Select…", value: "" },
                    ...(field.options || []).map((o) => ({ label: o, value: o })),
                  ]}
                  portal
                />
              </div>
            );
          }

          const inputType =
            field.type === "email" ? "email" : field.type === "phone" ? "tel" : "text";

          return (
            <div key={field.key}>
              {label}
              <input
                name={field.key}
                aria-invalid={invalidField === field.key || undefined}
                aria-describedby={invalidField === field.key ? feedbackId : undefined}
                id={id}
                type={inputType}
                value={values[field.key] || ""}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                }
                className={FULL_INPUT_CLS}
                required={field.required}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-6">
        <Button
          ref={submitRef}
          htmlType="submit"
          type="primary"
          loading={submitting}
          disabled={submitting || fields.length === 0}
          className="w-full"
        >
          Submit
        </Button>
      </div>
    </form>
  );
}
