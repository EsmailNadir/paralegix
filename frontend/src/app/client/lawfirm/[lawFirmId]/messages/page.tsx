"use client";

import { useParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import ConversationView from '@/components/messagesComp/ConversationView';
import { useClientPortal } from '@/contexts/ClientPortalContext';
import PageHeader from '@/components/ui/PageHeader';
import Card from '@/components/ui/Card';
import SectionLabel from '@/components/ui/SectionLabel';

export default function ClientLawFirmMessagesPage() {
  const params = useParams();
  const { user } = useAuth();
  const lawFirmId = params.lawFirmId as string;
  // The client layout already fetched the client's firms; resolve the name from
  // that shared list instead of re-requesting /client-portal/my-lawfirms.
  const { lawFirms } = useClientPortal();
  const lawFirmName = lawFirms.find((firm) => firm.id === lawFirmId)?.name || null;

  if (!user) {
    return <div>Not authenticated</div>;
  }

  // Generate conversation ID (format: `${lawFirmId}_${clientId}`)
  const conversationId = `${lawFirmId}_${user.uid}`;
  const clientId = user.uid;

  return (
    <div className="flex flex-col bg-page h-[calc(100dvh-3.5rem)] md:h-screen overflow-hidden">
      <div className="p-4 pl-5 md:p-6 max-w-[1600px] w-full mx-auto flex flex-col flex-1 min-h-0 min-w-0 gap-6">

        <PageHeader
          className="shrink-0"
          eyebrow="Conversations"
          title="Messages"
          description={
            <span className="hidden sm:block">
              Communicate directly with your law firm. Send messages and stay updated on your matters.
            </span>
          }
        />

        {/* Conversation Card */}
        <div className="flex flex-col flex-1 min-h-0">
          <SectionLabel gap="4" className="shrink-0">
            Conversation
          </SectionLabel>
          <Card className="flex-1 min-h-0">
            <ConversationView
              conversationId={conversationId}
              lawFirmId={lawFirmId}
              clientId={clientId}
              currentUserId={user.uid}
              isClient={true}
              recipientName={lawFirmName || undefined}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
