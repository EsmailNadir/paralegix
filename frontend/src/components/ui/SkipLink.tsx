'use client';

/** Skips page navigation by focusing the main landmark; BackButton returns to a previous page. */
export default function SkipLink() {
  return (
    <a
      href="#main-content"
      className="skip-link"
      onClick={() => document.getElementById('main-content')?.focus()}
    >
      Skip to main content
    </a>
  );
}
