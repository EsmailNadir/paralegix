'use client';

import { useParams, useSearchParams } from 'next/navigation';
import RequireFeature from '@/components/ui/RequireFeature';
import RequirePermission from '@/components/ui/RequirePermission';
import SignaturesWorkspace, { type SignaturesTab } from '@/components/signaturesComp/SignaturesWorkspace';

export default function SignaturesPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) as string;

  const tab: SignaturesTab = searchParams.get('tab') === 'templates' ? 'templates' : 'activity';

  if (!lawFirmId) return null;

  return (
    <RequireFeature feature="documentSigning">
      <RequirePermission permission="signatures.view" page>
        <SignaturesWorkspace
          lawFirmId={lawFirmId}
          initialTab={tab}
          initialTemplateSearch={searchParams.get('q') || ''}
        />
      </RequirePermission>
    </RequireFeature>
  );
}
