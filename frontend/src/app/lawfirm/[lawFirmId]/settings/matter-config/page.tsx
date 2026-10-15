'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Briefcase, Receipt, Building2, CalendarClock, ListChecks, Columns3, UserRound, ClipboardList, FileStack } from 'lucide-react';
import TabBar, { type TabBarTab } from '@/components/ui/TabBar';
import PracticeAreasPage from '../practice-area/page';
import ChargeCodesPage from '../charge-codes/page';
import CourtsPage from '../courts/page';
import DeadlineSetsPage from '../deadline-sets/page';
import MatterFieldsPage from '../matter-fields/page';
import MatterStagesPage from '../matter-stages/page';
import DocumentRequestTemplatesPage from '../document-request-templates/page';
import LeadStagesPage from '../lead-stages/page';
import IntakeFormsPage from '../intake-forms/page';
import SectionLabel from '@/components/ui/SectionLabel';
import { usePermissions } from '@/contexts/PermissionsContext';

type Section =
  | 'practiceAreas'
  | 'chargeCodes'
  | 'courts'
  | 'deadlineSets'
  | 'customFields'
  | 'stages'
  | 'documentTemplates'
  | 'leadStages'
  | 'intakeForms';

const sections: TabBarTab<Section>[] = [
  { value: 'practiceAreas', label: 'Practice Areas', icon: Briefcase },
  { value: 'customFields', label: 'Custom Fields', icon: ListChecks },
  { value: 'stages', label: 'Stages', icon: Columns3 },
  { value: 'documentTemplates', label: 'Document Request Presets', icon: FileStack },
  { value: 'leadStages', label: 'Lead Stages', icon: UserRound },
  { value: 'intakeForms', label: 'Intake Forms', icon: ClipboardList },
  { value: 'chargeCodes', label: 'Charge Codes', icon: Receipt },
  { value: 'courts', label: 'Courts', icon: Building2 },
  { value: 'deadlineSets', label: 'Deadline Sets', icon: CalendarClock },
];

/**
 * Sub-tabs whose every route, the list read included, needs a permission the
 * settings baseline does not carry. They are hidden rather than opened onto a
 * refused read.
 */
const SECTION_PERMISSION: Partial<Record<Section, string>> = {
  courts: 'courts.manage',
};

export default function MatterConfigPage() {
  const searchParams = useSearchParams();
  const { hasPermission } = usePermissions();
  const visibleSections = sections.filter((s) => {
    const required = SECTION_PERMISSION[s.value];
    return !required || hasPermission(required);
  });
  // Allow deep-linking to a specific sub-tab via ?tab=<section> (e.g. the
  // "Set up stages" flow on a matter links straight to the Stages tab).
  const initialTab = visibleSections.some((s) => s.value === searchParams.get('tab'))
    ? (searchParams.get('tab') as Section)
    : 'practiceAreas';
  const [active, setActive] = useState<Section>(initialTab);

  return (
    <div className="p-6 space-y-4">
      <div className="mb-5">
        <SectionLabel gap="1">Matter Configuration</SectionLabel>
        <p className="text-sm text-on-surface-secondary">
          Manage practice areas, charge codes, and courts used across your matters and tasks.
        </p>
      </div>

      {/* Sub-tabs */}
      <TabBar tabs={visibleSections} value={active} onChange={setActive} density="compact" />

      <div className="rounded-xl border border-outline">
        {active === 'practiceAreas' && <PracticeAreasPage />}
        {active === 'customFields' && <MatterFieldsPage />}
        {active === 'stages' && <MatterStagesPage />}
        {active === 'documentTemplates' && <DocumentRequestTemplatesPage />}
        {active === 'leadStages' && <LeadStagesPage />}
        {active === 'intakeForms' && <IntakeFormsPage />}
        {active === 'chargeCodes' && <ChargeCodesPage />}
        {active === 'courts' && <CourtsPage />}
        {active === 'deadlineSets' && <DeadlineSetsPage />}
      </div>
    </div>
  );
}
