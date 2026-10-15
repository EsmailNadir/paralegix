"use client";

import { useState } from "react";

/**
 * A password field with the show/hide eye toggle sat inside its right edge.
 *
 * The seven password fields on the auth pages (login, register, the two invite
 * accepts) each spelled this out: the input, the absolutely positioned button,
 * and the two eye paths inline. The paths are 24px Heroicons outline at stroke
 * 1.5, NOT the lucide `Eye`/`EyeOff` the rest of the app uses, so they are
 * reproduced here rather than swapped. Swapping them is a visual change to the
 * sign-in page and belongs in its own pass.
 *
 * The auth pages also use their own input metrics (`rounded-xl`, `px-3.5
 * py-2.5`, a 20% focus ring) rather than `TextInput`. That is the auth surface's
 * own language, shared by every field on those pages, so it stays.
 */
export default function PasswordInput({
  id,
  name,
  value,
  onChange,
  placeholder,
  required,
  autoComplete,
  toggleTabIndex,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  required?: boolean;
  autoComplete?: string;
  /**
   * Pass -1 to keep the toggle out of the tab order. The register and invite
   * forms do, so Tab runs straight from the password to the next field.
   */
  toggleTabIndex?: number;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        id={id}
        name={name}
        value={value}
        onChange={onChange}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
        className="w-full px-3.5 py-2.5 pr-10 bg-input-bg border border-input-border rounded-xl text-sm text-on-surface placeholder-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/20 transition-all"
      />
      <button
        type="button"
        onClick={() => setVisible((shown) => !shown)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        tabIndex={toggleTabIndex}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-muted hover:text-on-surface transition-colors cursor-pointer"
      >
        {visible ? (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12c1.292 4.338 5.31 7.5 10.066 7.5.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
          </svg>
        )}
      </button>
    </div>
  );
}
