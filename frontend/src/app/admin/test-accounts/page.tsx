'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Copy, UserPlus } from 'lucide-react';
import { flushSync } from 'react-dom';
import { useAuth } from '@/hooks/useAuth';
import LoadingSpinner from '@/components/LoadingSpinner';
import ErrorNotification from '@/components/ErrorNotification';
import Button from '@/components/ui/Button';
import Dropdown from '@/components/ui/Dropdown';
import AdminFirmPicker from '@/components/adminComp/AdminFirmPicker';
import userService from '@/services/users.service';
import FieldLabel from '@/components/ui/FieldLabel';
import { FULL_INPUT_CLS } from '@/components/ui/inputClasses';
import AdminAccessRequired from '@/components/adminComp/AdminAccessRequired';
import adminService, {
  type CreatedTestAccount,
  type CreateTestAccountPayload,
  type TestAccountKind,
} from '@/services/admin.service';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}


const KIND_OPTIONS: { label: string; value: TestAccountKind }[] = [
  { label: 'Firm owner + new firm', value: 'firm_owner' },
  { label: 'Client', value: 'client' },
  { label: 'Member of existing firm', value: 'member' },
];

const KIND_LABELS: Record<TestAccountKind, string> = {
  firm_owner: 'Firm owner',
  client: 'Client',
  member: 'Member',
};

type FormState = {
  kind: TestAccountKind;
  name: string;
  email: string;
  password: string;
  firmName: string;
  lawFirmId: string;
  roleId: string;
};

const INITIAL_FORM_STATE: FormState = {
  kind: 'firm_owner',
  name: '',
  email: '',
  password: 'password',
  firmName: '',
  lawFirmId: '',
  roleId: '',
};

export default function AdminTestAccountsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [checkingAccess, setCheckingAccess] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | Error | null>(null);

  const [form, setForm] = useState<FormState>(INITIAL_FORM_STATE);
  const [created, setCreated] = useState<CreatedTestAccount | null>(null);
  const [copied, setCopied] = useState(false);

  const navigateTo = useCallback((path: string) => {
    if (navigating) return;

    flushSync(() => {
      setNavigating(true);
    });

    window.requestAnimationFrame(() => {
      router.push(path);
    });
  }, [navigating, router]);

  useEffect(() => {
    if (authLoading) return;

    if (!user) {
      router.replace('/login');
      return;
    }

    let active = true;

    const checkAccess = async () => {
      setCheckingAccess(true);
      setError(null);

      try {
        const profile = await userService.getProfile();
        const hasAdminAccess = (profile as { isAdmin?: boolean })?.isAdmin === true;

        if (!active) return;

        setIsAdmin(hasAdminAccess);
      } catch (err) {
        if (!active) return;
        setError(getErrorMessage(err));
      } finally {
        if (active) {
          setCheckingAccess(false);
        }
      }
    };

    checkAccess();

    return () => {
      active = false;
    };
  }, [authLoading, user, router]);

  const setField = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const resetForm = useCallback(() => {
    setForm(INITIAL_FORM_STATE);
    setCreated(null);
    setFormError(null);
    setCopied(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    const name = form.name.trim();
    const email = form.email.trim();
    const password = form.password;

    if (!name) {
      setFormError('Name is required.');
      return;
    }
    if (!email) {
      setFormError('Email is required.');
      return;
    }
    if (!password) {
      setFormError('Password is required.');
      return;
    }
    if (form.kind === 'member' && !form.lawFirmId.trim()) {
      setFormError('Law firm is required for a member account.');
      return;
    }

    const payload: CreateTestAccountPayload = {
      kind: form.kind,
      name,
      email,
      password,
    };

    if (form.kind === 'firm_owner' && form.firmName.trim()) {
      payload.firmName = form.firmName.trim();
    }
    if ((form.kind === 'member' || form.kind === 'client') && form.lawFirmId.trim()) {
      payload.lawFirmId = form.lawFirmId.trim();
    }
    if (form.kind === 'member' && form.roleId.trim()) {
      payload.roleId = form.roleId.trim();
    }

    setSubmitting(true);
    setFormError(null);

    try {
      const account = await adminService.createTestAccount(payload);
      setCreated(account);
    } catch (err) {
      setFormError(err instanceof Error ? err : getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }, [form]);

  const handleCopy = useCallback(async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(`${created.email} / ${created.password}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable; the credentials remain visible to copy manually.
    }
  }, [created]);

  if (authLoading || checkingAccess || navigating) {
    return <LoadingSpinner fullPage />;
  }

  if (!user) {
    return null;
  }

  if (!isAdmin) {
    return <AdminAccessRequired onBack={() => navigateTo('/dashboard')} />;
  }

  return (
    <div className="min-h-screen bg-page p-4 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="bg-surface rounded-2xl border border-outline-subtle p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.12em] text-on-surface-muted font-semibold">Global Admin</p>
              <h1 className="text-2xl font-bold text-on-surface mt-1">Test Accounts</h1>
              <p className="text-sm text-on-surface-secondary mt-1">
                Create pre-verified accounts that can log in immediately.
              </p>
            </div>

            <Button type="secondary" onClick={() => navigateTo('/admin')}>
              Back to Admin Console
            </Button>
          </div>
        </div>

        <ErrorNotification error={error} onClose={() => setError(null)} />

        {created ? (
          <div className="bg-surface rounded-2xl border border-outline-subtle shadow-sm p-6 space-y-5">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-green-50 dark:bg-green-900/30 flex items-center justify-center shrink-0">
                <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-on-surface">Account created</h2>
                <p className="text-sm text-on-surface-secondary">
                  This {KIND_LABELS[form.kind].toLowerCase()} account is pre-verified and ready to log in.
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-outline-subtle bg-surface-alt p-4 space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-on-surface-muted">Email</span>
                <span className="font-medium text-on-surface break-all">{created.email}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-on-surface-muted">Password</span>
                <span className="font-mono font-medium text-on-surface break-all">{created.password}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-on-surface-muted">User type</span>
                <span className="font-medium text-on-surface capitalize">{created.userType.replace(/_/g, ' ')}</span>
              </div>
              {created.lawFirmId && (
                <div className="flex justify-between gap-4">
                  <span className="text-on-surface-muted">Law firm ID</span>
                  <span className="font-mono font-medium text-on-surface break-all">{created.lawFirmId}</span>
                </div>
              )}
              {created.roleId && (
                <div className="flex justify-between gap-4">
                  <span className="text-on-surface-muted">Role ID</span>
                  <span className="font-mono font-medium text-on-surface break-all">{created.roleId}</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="secondary"
                onClick={handleCopy}
                icon={<Copy className="w-4 h-4" />}
              >
                {copied ? 'Copied' : 'Copy credentials'}
              </Button>
              <Button type="primary" onClick={resetForm} icon={<UserPlus className="w-4 h-4" />}>
                Create another
              </Button>
            </div>
          </div>
        ) : (
          <div className="bg-surface rounded-2xl border border-outline-subtle shadow-sm p-6 space-y-5">
            <ErrorNotification error={formError} onClose={() => setFormError(null)} />

            <Dropdown
              label="Account type"
              value={form.kind}
              onChange={(value) => setField('kind', value as TestAccountKind)}
              options={KIND_OPTIONS}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <FieldLabel>Name *</FieldLabel>
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) => setField('name', event.target.value)}
                  placeholder="Test User"
                  className={FULL_INPUT_CLS}
                  maxLength={200}
                />
              </div>

              <div>
                <FieldLabel>Email *</FieldLabel>
                <input
                  type="email"
                  value={form.email}
                  onChange={(event) => setField('email', event.target.value)}
                  placeholder="test@example.com"
                  className={FULL_INPUT_CLS}
                  maxLength={254}
                />
              </div>

              <div>
                <FieldLabel>Password *</FieldLabel>
                <input
                  type="text"
                  value={form.password}
                  onChange={(event) => setField('password', event.target.value)}
                  className={FULL_INPUT_CLS}
                  maxLength={128}
                />
              </div>

              {form.kind === 'firm_owner' && (
                <div>
                  <FieldLabel>Firm name</FieldLabel>
                  <input
                    type="text"
                    value={form.firmName}
                    onChange={(event) => setField('firmName', event.target.value)}
                    placeholder="Defaults if left blank"
                    className={FULL_INPUT_CLS}
                    maxLength={200}
                  />
                </div>
              )}
            </div>

            {(form.kind === 'member' || form.kind === 'client') && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <AdminFirmPicker
                    label={form.kind === 'member' ? 'Law firm *' : 'Law firm'}
                    value={form.lawFirmId}
                    onChange={(value) => setField('lawFirmId', value)}
                  />
                </div>

                {form.kind === 'member' && (
                  <div>
                    <FieldLabel>Role ID</FieldLabel>
                    <input
                      type="text"
                      value={form.roleId}
                      onChange={(event) => setField('roleId', event.target.value)}
                      placeholder="Defaults to the firm's member role"
                      className={FULL_INPUT_CLS}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-end">
              <Button
                type="primary"
                onClick={handleSubmit}
                loading={submitting}
                icon={<UserPlus className="w-4 h-4" />}
              >
                Create account
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
