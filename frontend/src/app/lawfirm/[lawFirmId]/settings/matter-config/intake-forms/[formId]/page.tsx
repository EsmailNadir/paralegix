'use client';

import { useParams } from 'next/navigation';
import IntakeFormEditor from '@/components/settingsComp/IntakeFormEditor';

export default function EditIntakeFormPage() {
  const params = useParams();
  const formId = Array.isArray(params?.formId) ? params.formId[0] : (params?.formId as string);
  return <IntakeFormEditor formId={formId} />;
}
