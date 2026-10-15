'use client';

import MatterStagesSettings from '@/components/settingsComp/MatterStagesSettings';

// No permission gate here: MatterStagesSettings already hides its create/edit/delete
// controls and shows a notice when the member lacks `settings.manageFirm`, so the tab
// renders read-only instead of replacing the panel with a denial message.
export default function MatterStagesPage() {
  return <MatterStagesSettings />;
}
