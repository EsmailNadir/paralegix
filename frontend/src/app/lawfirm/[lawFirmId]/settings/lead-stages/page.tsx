'use client';

import LeadStagesSettings from '@/components/settingsComp/LeadStagesSettings';

// No permission gate here: LeadStagesSettings already hides its create/edit/delete
// controls and shows a notice when the member lacks `leads.manageStages`, so the tab
// renders read-only instead of replacing the panel with a denial message.
export default function LeadStagesPage() {
  return <LeadStagesSettings />;
}
