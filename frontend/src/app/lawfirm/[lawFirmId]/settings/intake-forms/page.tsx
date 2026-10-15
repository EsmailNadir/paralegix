'use client';

import IntakeFormsSettings from '@/components/settingsComp/IntakeFormsSettings';

// No permission gate here: IntakeFormsSettings already hides its create/edit/delete
// controls and shows a notice when the member lacks `leads.manage`, so the tab
// renders read-only instead of replacing the panel with a denial message.
export default function IntakeFormsPage() {
  return <IntakeFormsSettings />;
}
