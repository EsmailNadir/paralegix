'use client';

import MatterFieldsSettings from '@/components/settingsComp/MatterFieldsSettings';

// No permission gate here: MatterFieldsSettings already hides its create/edit/delete
// controls and shows a notice when the member lacks `settings.manageFirm`, so the tab
// renders read-only instead of replacing the panel with a denial message.
export default function MatterFieldsPage() {
  return <MatterFieldsSettings />;
}
