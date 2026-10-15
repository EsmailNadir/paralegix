import { intakeBadge } from '@/components/leadComp/LeadDetailModal';
import type { LatestIntakeSubmission } from '@/types/lead';

const submission: LatestIntakeSubmission = {
  id: 'submission', status: 'sent', intakeFormTemplateId: 'form',
  sentToEmail: 'recipient@example.test', sentAt: null, openedAt: null, completedAt: null,
};

it('shows an email failure instead of claiming the intake form was sent', () => {
  expect(intakeBadge({ ...submission, deliveryStatus: 'failed' })).toEqual({ label: 'Email failed', variant: 'warning' });
});

it('shows pending delivery instead of claiming the intake form was sent', () => {
  expect(intakeBadge({ ...submission, deliveryStatus: 'pending' })).toEqual({ label: 'Sending', variant: 'neutral' });
});

it('keeps a completed submission completed after a delivery failure', () => {
  expect(intakeBadge({ ...submission, status: 'completed', deliveryStatus: 'failed' }))
    .toEqual({ label: 'Completed', variant: 'success' });
});
