'use client';

import { useParams } from 'next/navigation';
import { CreditCard, Users, CalendarDays, Image as ImageIcon, CheckCircle2, ChevronRight, ArrowRight } from 'lucide-react';
import { useNavigation } from '@/contexts/NavigationContext';
import { useFirmSettings } from '@/contexts/FirmSettingsContext';
import { useGetStartedProgress, type GetStartedStatus } from '@/hooks/useGetStartedProgress';
import PageHeader from '@/components/ui/PageHeader';
import Spinner from '@/components/ui/Spinner';
import type { LucideIcon } from 'lucide-react';
import Button from '@/components/ui/Button';

interface SetupCard {
  key: string;
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel: string;
  href: string;
  status: GetStartedStatus;
}

export default function GetStartedPage() {
  const params = useParams();
  const lawFirmId = (Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : params?.lawFirmId) || '';
  const { navigate } = useNavigation();
  const { features } = useFirmSettings();
  const { stripeConnected, teamInvited, calendarConnected, logoAdded, doneCount, totalCount } =
    useGetStartedProgress(lawFirmId);

  const cards: SetupCard[] = [
    {
      key: 'stripe',
      icon: CreditCard,
      title: 'Connect Stripe',
      description: 'Accept online payments and get paid faster.',
      actionLabel: 'Connect Stripe',
      href: `/lawfirm/${lawFirmId}/settings/payments`,
      status: stripeConnected,
    },
    {
      key: 'team',
      icon: Users,
      title: 'Invite your team',
      description: 'Bring your colleagues into the firm.',
      actionLabel: 'Invite team',
      href: `/lawfirm/${lawFirmId}/settings/members`,
      status: teamInvited,
    },
    ...(features.calendarSync
      ? [{
          key: 'calendar',
          icon: CalendarDays,
          title: 'Connect your calendar',
          description: 'Sync deadlines and events with Google or Outlook.',
          actionLabel: 'Connect calendar',
          href: `/lawfirm/${lawFirmId}/settings/general`,
          status: calendarConnected,
        }]
      : []),
    {
      key: 'logo',
      icon: ImageIcon,
      title: 'Add your firm logo',
      description: 'Shows up on invoices and your client portal.',
      actionLabel: 'Add logo',
      href: `/lawfirm/${lawFirmId}/settings/general`,
      status: logoAdded,
    },
  ];

  const progressPct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  return (
    <div className="min-h-screen bg-page">
      <div className="p-4 pl-5 md:p-6 max-w-3xl mx-auto space-y-6 min-w-0">
        <PageHeader
          title="Let's get your firm set up"
          description="Optional. You can always finish these later from Settings."
          actions={
            <div className="flex items-center gap-2">
              <div className="w-24 bg-surface-alt rounded-full h-2 overflow-hidden">
                <div
                  className="bg-accent-solid h-2 rounded-full transition-all duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <span className="text-xs font-medium text-on-surface-secondary whitespace-nowrap">
                {doneCount} of {totalCount} done
              </span>
            </div>
          }
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {cards.map((card) => (
            <SetupCardTile key={card.key} card={card} onAction={() => navigate(card.href)} />
          ))}
        </div>

        <button
          type="button"
          onClick={() => navigate('/docs')}
          className="inline-flex items-center gap-1.5 text-sm text-on-surface-secondary hover:text-accent-emphasis dark:hover:text-accent-emphasis transition-colors cursor-pointer"
        >
          New here? Explore the docs
          <ArrowRight size={14} strokeWidth={2} />
        </button>

        <div className="pt-2 flex justify-center">
          <Button
            size="compact"
            onClick={() => navigate(`/lawfirm/${lawFirmId}`)}
          >
            Go to dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}

function SetupCardTile({ card, onAction }: { card: SetupCard; onAction: () => void }) {
  const Icon = card.icon;
  const checking = card.status === undefined;
  const done = card.status === true;

  return (
    <div className="bg-surface rounded-2xl border border-outline-subtle p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div
          className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
            done
              ? 'bg-emerald-100 dark:bg-emerald-500/15'
              : checking
                ? 'bg-surface-alt'
                : 'bg-accent-soft dark:bg-accent-soft'
          }`}
        >
          <Icon
            size={20}
            strokeWidth={1.8}
            className={
              done
                ? 'text-emerald-600 dark:text-emerald-400'
                : checking
                  ? 'text-on-surface-muted'
                  : 'text-accent-emphasis'
            }
          />
        </div>
        {done && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400 shrink-0">
            <CheckCircle2 size={14} />
            Done
          </span>
        )}
      </div>

      <h3 className="text-sm font-semibold text-on-surface mt-3">{card.title}</h3>
      <p className="text-sm text-on-surface-secondary mt-1">{card.description}</p>

      {!done && (
        checking ? (
          <div className="mt-4 inline-flex items-center gap-1.5 text-xs text-on-surface-muted">
            <Spinner size={14} className="text-on-surface-muted" />
            Checking...
          </div>
        ) : (
          <Button
            type="secondary"
            size="compact"
            onClick={onAction}
            className="mt-4"
          >
            {card.actionLabel}
            <ChevronRight size={14} strokeWidth={2} />
          </Button>
        )
      )}
    </div>
  );
}
