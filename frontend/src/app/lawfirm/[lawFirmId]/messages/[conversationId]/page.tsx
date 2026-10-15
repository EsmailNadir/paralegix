"use client";

import { Suspense } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useNavigation } from '@/contexts/NavigationContext';
import { useAuth } from '@/hooks/useAuth';
import ConversationView from '@/components/messagesComp/ConversationView';
import RequirePermission from '@/components/ui/RequirePermission';
import RequireFeature from '@/components/ui/RequireFeature';
import { ArrowLeft } from 'lucide-react';
import Card from '@/components/ui/Card';

// useSearchParams requires a Suspense boundary during the Next.js build.
export default function FirmConversationPage() {
  return (
    <Suspense fallback={null}>
      <FirmConversationContent />
    </Suspense>
  );
}

function FirmConversationContent() {
  const params = useParams();
  const router = useRouter();
  const { navigate } = useNavigation();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const lawFirmId = params.lawFirmId as string;
  const conversationId = params.conversationId as string;
  // Group threads are opened with ?type=group from the merged conversation list
  // (a UUID alone can't distinguish a direct thread from a group).
  const isGroup = searchParams.get('type') === 'group';

  // New conversations started from the client selector use a synthetic
  // `${lawFirmId}_${clientId}` id; existing conversations use a Postgres UUID.
  // For the synthetic form we can recover clientId from the url. Otherwise it
  // comes from the loaded conversation (ConversationView falls back to that).
  const prefix = `${lawFirmId}_`;
  const clientId = conversationId.startsWith(prefix)
    ? conversationId.slice(prefix.length)
    : '';

  if (!user) {
    return <div>Not authenticated</div>;
  }

  if (!conversationId) {
    return <div>Invalid conversation</div>;
  }

  return (
    <RequirePermission permission="messaging.view" page>
      <RequireFeature feature="messaging">
      {/* Mobile: viewport height minus the fixed h-14 top bar (dvh tracks the
          browser chrome) so the page itself never scrolls, only the message
          list does. Desktop has no top bar. */}
      <div className="h-[calc(100dvh-3.5rem)] md:h-screen overflow-hidden flex flex-col bg-page">
        <div className="flex-1 flex flex-col p-3 md:p-6 max-w-[1600px] mx-auto w-full gap-3 md:gap-4 min-h-0">

          {/* Back Link */}
          <button
            onClick={() => navigate(`/lawfirm/${lawFirmId}/messages`)}
            className="group flex items-center gap-1.5 text-sm font-medium text-on-surface-secondary hover:text-accent-emphasis dark:hover:text-accent-emphasis transition-colors flex-shrink-0 cursor-pointer"
          >
            <ArrowLeft size={15} className="group-hover:-translate-x-0.5 transition-transform" />
            All Messages
          </button>

          {/* Conversation Card */}
          <div className="flex-1 min-h-0">
            <Card className="h-full">
              <ConversationView
                conversationId={conversationId}
                lawFirmId={lawFirmId}
                clientId={clientId}
                currentUserId={user.uid}
                isClient={false}
                isGroup={isGroup}
                onConvertedToGroup={() =>
                  router.replace(`/lawfirm/${lawFirmId}/messages/${conversationId}?type=group`)
                }
                onConversationCreated={(createdId) =>
                  router.replace(`/lawfirm/${lawFirmId}/messages/${createdId}`)
                }
              />
            </Card>
          </div>
        </div>
      </div>
    </RequireFeature>
    </RequirePermission>
  );
}
