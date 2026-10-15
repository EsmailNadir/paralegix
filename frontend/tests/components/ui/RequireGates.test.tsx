import React from 'react';
import { render, screen } from '@testing-library/react';
import RequirePermission from '@/components/ui/RequirePermission';
import RequireFeature from '@/components/ui/RequireFeature';
import { grantPermissions, resetPermissions } from '../../support/permissions';
import { mockPermissionsValue } from '../../setup';

const mockFirmSettings = {
  loading: false,
  features: {
    trustAccounting: true,
    clientPortal: false,
    analytics: true,
  },
};

jest.mock('@/contexts/FirmSettingsContext', () => ({
  useFirmSettings: () => mockFirmSettings,
}));

afterEach(() => {
  resetPermissions();
  delete (mockPermissionsValue as any).loadError;
  mockFirmSettings.loading = false;
  mockFirmSettings.features = {
    trustAccounting: true,
    clientPortal: false,
    analytics: true,
  };
});

describe('RequirePermission', () => {
  it('renders children when single permission is granted', () => {
    grantPermissions(['matters.view']);

    render(
      <RequirePermission permission="matters.view">
        <div>Matter Content</div>
      </RequirePermission>
    );

    expect(screen.getByText('Matter Content')).toBeInTheDocument();
  });

  it('renders fallback when permission is missing in inline mode', () => {
    grantPermissions(['tasks.view']);

    render(
      <RequirePermission
        permission="matters.view"
        fallback={<div>No Access Inline</div>}
      >
        <div>Matter Content</div>
      </RequirePermission>
    );

    expect(screen.queryByText('Matter Content')).not.toBeInTheDocument();
    expect(screen.getByText('No Access Inline')).toBeInTheDocument();
  });

  it('renders AccessDeniedPage when permission is missing in page mode', () => {
    grantPermissions([]);

    render(
      <RequirePermission
        permission="billing.manage"
        page={true}
        deniedTitle="Billing Restricted"
      >
        <div>Billing Records</div>
      </RequirePermission>
    );

    expect(screen.queryByText('Billing Records')).not.toBeInTheDocument();
    expect(screen.getByText('Billing Restricted')).toBeInTheDocument();
  });

  it('handles "any" vs "all" permission modes', () => {
    grantPermissions(['matters.view']);

    // "any" mode: should succeed with one matching permission
    const { rerender } = render(
      <RequirePermission permission={['matters.view', 'matters.create']} mode="any">
        <div>Any Matched</div>
      </RequirePermission>
    );
    expect(screen.getByText('Any Matched')).toBeInTheDocument();

    // "all" mode: should fail because matters.create is missing
    rerender(
      <RequirePermission
        permission={['matters.view', 'matters.create']}
        mode="all"
        fallback={<div>Missing All</div>}
      >
        <div>All Matched</div>
      </RequirePermission>
    );
    expect(screen.queryByText('All Matched')).not.toBeInTheDocument();
    expect(screen.getByText('Missing All')).toBeInTheDocument();
  });

  it('renders retry status page on loadError in page mode', () => {
    (mockPermissionsValue as any).loadError = new Error('Network error');

    render(
      <RequirePermission permission="matters.view" page={true}>
        <div>Protected Page</div>
      </RequirePermission>
    );

    expect(screen.queryByText('Protected Page')).not.toBeInTheDocument();
    expect(screen.getByText("We couldn't load your access")).toBeInTheDocument();
  });
});

describe('RequireFeature', () => {
  it('renders children when feature is enabled', () => {
    render(
      <RequireFeature feature="trustAccounting">
        <div>Trust Balance Panel</div>
      </RequireFeature>
    );

    expect(screen.getByText('Trust Balance Panel')).toBeInTheDocument();
  });

  it('renders fallback or FeatureDisabledPage when feature is disabled', () => {
    const { rerender } = render(
      <RequireFeature
        feature="clientPortal"
        fallback={<div>Portal Disabled Fallback</div>}
      >
        <div>Portal Settings</div>
      </RequireFeature>
    );

    expect(screen.queryByText('Portal Settings')).not.toBeInTheDocument();
    expect(screen.getByText('Portal Disabled Fallback')).toBeInTheDocument();

    rerender(
      <RequireFeature feature="clientPortal">
        <div>Portal Settings</div>
      </RequireFeature>
    );

    // Every plan includes `clientPortal`, so a disabled one can only ever be the
    // firm's own opt-out. The page used to answer "not available on your current
    // plan" here, which told a firm to upgrade to a plan it was already on.
    expect(screen.getByText(/client portal is turned off for your firm/i))
      .toBeInTheDocument();
  });

  it('renders nothing while loading', () => {
    mockFirmSettings.loading = true;

    render(
      <RequireFeature feature="trustAccounting">
        <div>Trust Balance Panel</div>
      </RequireFeature>
    );

    expect(screen.queryByText('Trust Balance Panel')).not.toBeInTheDocument();
  });
});
