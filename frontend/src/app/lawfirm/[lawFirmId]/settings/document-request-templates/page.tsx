'use client';

import DocumentRequestTemplatesSettings from '@/components/settingsComp/DocumentRequestTemplatesSettings';

// No permission gate here: DocumentRequestTemplatesSettings already hides its create/edit/delete
// controls and shows a notice when the member lacks `settings.manageFirm`, so the tab
// renders read-only instead of replacing the panel with a denial message.
export default function DocumentRequestTemplatesPage() {
  return <DocumentRequestTemplatesSettings />;
}
