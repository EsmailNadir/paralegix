import type { ReactElement } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AlertTriangle } from 'lucide-react';
import AccessDeniedPage from '@/components/ui/AccessDeniedPage';
import AuthRequiredPage from '@/components/ui/AuthRequiredPage';
import ConnectionUnavailable from '@/components/ui/ConnectionUnavailable';
import InvalidLinkPage from '@/components/ui/InvalidLinkPage';
import MaintenancePage from '@/components/ui/MaintenancePage';
import StatusPage from '@/components/ui/StatusPage';
import UnexpectedErrorPage from '@/components/ui/UnexpectedErrorPage';

describe('StatusPage', () => {
  it('renders the title, description, action button and error code', () => {
    render(
      <StatusPage
        badge="Error"
        title="Something went wrong"
        description="An unexpected error occurred."
        Icon={AlertTriangle}
        code="500"
        primaryAction={{ label: 'Retry', onClick: jest.fn() }}
      />,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('An unexpected error occurred.')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
  });
});

describe('status pages built on StatusPage', () => {
  it.each<[string, () => ReactElement, string[]]>([
    [
      'AccessDeniedPage',
      () => <AccessDeniedPage />,
      ['403', 'Access denied', 'You do not have access to this area', 'Back to dashboard'],
    ],
    [
      'AuthRequiredPage',
      () => <AuthRequiredPage />,
      ['401', 'Authentication required', 'Sign in to continue', 'Go to sign in', 'Back home'],
    ],
    [
      'InvalidLinkPage',
      () => <InvalidLinkPage />,
      ['Invalid link', 'This link is no longer valid', 'Back to login'],
    ],
    [
      'MaintenancePage',
      () => <MaintenancePage onRetry={jest.fn()} isRetrying={false} />,
      ['503', 'Maintenance mode', 'Paralegix is under maintenance'],
    ],
    [
      'ConnectionUnavailable',
      () => <ConnectionUnavailable onRetry={jest.fn()} isRetrying={false} />,
      ['Connection issue', "We're having trouble reaching the server"],
    ],
    [
      'UnexpectedErrorPage with details',
      () => <UnexpectedErrorPage details="Stack trace here" />,
      ['Stack trace here'],
    ],
  ])('%s renders its fixed copy', (_name, build, texts) => {
    render(build());

    for (const text of texts) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });

  it.each<[string, (onRetry: () => void) => ReactElement]>([
    ['MaintenancePage', (onRetry) => <MaintenancePage onRetry={onRetry} isRetrying={false} />],
    [
      'ConnectionUnavailable',
      (onRetry) => <ConnectionUnavailable onRetry={onRetry} isRetrying={false} />,
    ],
    ['UnexpectedErrorPage', (onRetry) => <UnexpectedErrorPage onRetry={onRetry} />],
  ])('%s calls onRetry from its Try again button', (_name, build) => {
    const handleRetry = jest.fn();
    render(build(handleRetry));

    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));

    expect(handleRetry).toHaveBeenCalled();
  });
});
