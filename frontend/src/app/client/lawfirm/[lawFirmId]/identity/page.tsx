"use client";

import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { QrCode, Wallet } from "lucide-react";
import LoadingSpinner from "@/components/LoadingSpinner";
import ErrorNotification from "@/components/ErrorNotification";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Spinner from "@/components/ui/Spinner";
import StatusBadge from "@/components/ui/StatusBadge";
import ClientRecordPicker from "@/components/portalComp/ClientRecordPicker";
import { useClientPortal } from "@/contexts/ClientPortalContext";
import {
  identityStatusQueryKey,
  useIdentityStatus,
  useIdentityVerification,
  type IdentityFlowState,
} from "@/hooks/useIdentityVerification";
import { formatDate } from "@/lib/utils/dateUtils";
import type { PortalIdentityStatus, VerificationResult } from "@/types/identityVerification";

const INTRO =
  "Your attorney asks for this once. You'll share your name and the state that issued your ID. Paralegix doesn't keep a copy of your ID.";
const NOT_AVAILABLE =
  "Identity verification isn't available yet. Your attorney's office will let you know when it is.";
const NAME_DIFFERS =
  "The name on your ID doesn't match the name your attorney's office has on file. You're still verified, but please contact your attorney's office so they can update their records.";

/** The neutral notice block the portal uses for a calm, non-error message. */
const NOTICE_CLS = "rounded-xl border border-outline-subtle bg-surface px-4 py-3 text-sm text-on-surface-secondary";

/** Client-facing copy for a refused request. Never the server's own message. */
function errorCopy(status: number | null, code: string | null): string {
  if (code === "IDENTITY_VERIFICATION_UNCONFIGURED") return NOT_AVAILABLE;
  if (status === 429) return "You've tried this several times. Please wait a little while, then try again.";
  if (status === 502) return "The ID check service isn't responding right now. Please try again in a few minutes.";
  if (status === 503) return "Identity verification isn't available right now. Please try again later or contact your attorney's office.";
  if (status === 409) return "This verification expired before it finished. Please start again.";
  if (code === "WALLET_ERROR") return "Your phone's wallet couldn't share your ID. Please try again.";
  return "Something went wrong while verifying your ID. Please try again.";
}

function verifiedName(result: VerificationResult): string {
  return [result.verifiedName?.given, result.verifiedName?.family].filter(Boolean).join(" ");
}

function VerifiedPanel({ result }: { result: VerificationResult }) {
  return (
    <Card className="p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-on-surface">You&apos;re verified</h2>
        <StatusBadge variant="success">Verified</StatusBadge>
        {result.nameMatchesRecord === false && <StatusBadge variant="warning">Name differs</StatusBadge>}
      </div>
      <dl className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="space-y-1">
          <dt className="text-xs text-on-surface-muted">Name on your ID</dt>
          <dd className="text-sm text-on-surface">{verifiedName(result) || "Not provided"}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs text-on-surface-muted">Issued by</dt>
          <dd className="text-sm text-on-surface">{result.issuer || "Not provided"}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs text-on-surface-muted">Verified on</dt>
          <dd className="text-sm text-on-surface">{formatDate(result.completedAt ?? result.createdAt)}</dd>
        </div>
      </dl>
      {result.nameMatchesRecord === false && <p className={NOTICE_CLS}>{NAME_DIFFERS}</p>}
    </Card>
  );
}

function RetryPanel({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <Card className="p-6 space-y-4">
      <h2 className="text-lg font-semibold text-on-surface">{title}</h2>
      <p className="text-sm text-on-surface-secondary">{message}</p>
      <Button type="primary" onClick={onRetry}>Try again</Button>
    </Card>
  );
}

function WaitingPanel({ title, message }: { title: string; message: string }) {
  return (
    <Card className="p-6 space-y-2">
      <p role="status" className="flex items-center gap-2 text-sm font-semibold text-on-surface">
        <Spinner size={16} />
        {title}
      </p>
      <p className="text-sm text-on-surface-secondary">{message}</p>
    </Card>
  );
}

export default function ClientIdentityPage() {
  const params = useParams();
  const lawFirmId = params.lawFirmId as string;
  const { associations, associationsLoading, activeAssociation, selectionRequired, setActiveClientRecordId } = useClientPortal();
  const clientRecordId = activeAssociation?.clientRecordId;
  // Verification checks a person's own ID, so an organization link has nothing to verify.
  const isOrganization = activeAssociation?.clientType === "company";
  const queryClient = useQueryClient();

  const status = useIdentityStatus(lawFirmId, clientRecordId, !associationsLoading && !selectionRequired && !isOrganization);
  const flow = useIdentityVerification({
    lawFirmId,
    clientRecordId,
    // The verdict becomes the latest result in the shared cache, so the firm
    // home card disappears without another request.
    onFinished: (result) => {
      queryClient.setQueryData<PortalIdentityStatus>(
        identityStatusQueryKey(lawFirmId, clientRecordId),
        (previous) => (previous ? { ...previous, latest: result } : previous),
      );
    },
  });

  if (selectionRequired) {
    return <ClientRecordPicker associations={associations} onSelect={setActiveClientRecordId} />;
  }

  if (associationsLoading || status.isLoading) {
    return <LoadingSpinner fullPage />;
  }

  return (
    <div className="p-8 max-w-[1600px] mx-auto min-w-0">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-on-surface">Verify your identity</h1>
        <p className="text-sm text-on-surface-muted mt-1">{INTRO}</p>
      </div>

      <div aria-live="polite">
        {isOrganization ? (
          <p className={NOTICE_CLS}>
            Identity verification is for individual clients. Switch to your personal account to verify your identity.
          </p>
        ) : status.error ? (
          <ErrorNotification
            error="We couldn't load your verification status."
            onRetry={() => void status.refetch()}
            retrying={status.isFetching}
          />
        ) : !status.data?.configured ? (
          <p className={NOTICE_CLS}>{NOT_AVAILABLE}</p>
        ) : (
          <FlowBody
            state={flow.state}
            latest={status.data.latest}
            supportsWallet={flow.supportsWallet}
            onPrefetch={flow.prefetch}
            onVerifyWithWallet={() => void flow.verifyWithWallet()}
            onShowQrCode={() => void flow.showQrCode()}
            onReset={flow.reset}
          />
        )}
      </div>
    </div>
  );
}

interface FlowBodyProps {
  state: IdentityFlowState;
  latest: VerificationResult | null;
  supportsWallet: boolean;
  onPrefetch: () => void;
  onVerifyWithWallet: () => void;
  onShowQrCode: () => void;
  onReset: () => void;
}

function FlowBody({ state, latest, supportsWallet, onPrefetch, onVerifyWithWallet, onShowQrCode, onReset }: FlowBodyProps) {
  switch (state.kind) {
    case "finished":
      if (state.result.status === "verified") return <VerifiedPanel result={state.result} />;
      if (state.result.status === "cancelled") {
        return <RetryPanel title="Verification cancelled" message="Nothing was shared. You can try again whenever you are ready." onRetry={onReset} />;
      }
      return (
        <RetryPanel
          title="We couldn't verify your ID"
          message="Your ID couldn't be confirmed. Make sure you're sharing the ID in your phone's wallet, then try again. If this keeps happening, contact your attorney's office."
          onRetry={onReset}
        />
      );
    case "cancelled":
      return <RetryPanel title="Verification cancelled" message="Nothing was shared. You can try again whenever you are ready." onRetry={onReset} />;
    case "timedOut":
      return (
        <RetryPanel
          title="The QR code expired"
          message="Your wallet app didn't respond within three minutes. Nothing was shared."
          onRetry={onReset}
        />
      );
    case "error":
      return <ErrorNotification error={errorCopy(state.status, state.code)} onRetry={onReset} />;
    case "wallet":
      return (
        <WaitingPanel
          title="Waiting for your wallet..."
          message="Confirm in your phone's wallet to share your name and the state that issued your ID."
        />
      );
    case "verifying":
      return <WaitingPanel title="Checking your ID..." message="This only takes a moment." />;
    case "qr":
      return (
        <Card className="p-6 space-y-4">
          <p role="status" className="flex items-center gap-2 text-sm font-semibold text-on-surface">
            <Spinner size={16} />
            Waiting for your wallet app...
          </p>
          <p className="text-sm text-on-surface-secondary">
            Scan this code with your phone&apos;s camera to open your wallet app, then confirm there.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL, not an optimizable asset */}
          <img src={state.qrDataUrl} alt="QR code to open your wallet app" width={240} height={240} className="rounded-lg border border-outline-subtle" />
          <div className="flex flex-wrap gap-2">
            {/* The wallet app's own URL scheme, so a plain anchor rather than
                in-app navigation. Styled as the primary <Button>, which has no
                link form; shown on phones, where scanning the QR is not an option. */}
            <a
              href={state.walletUrl}
              className="md:hidden inline-flex items-center justify-center font-medium transition-[background-color,border-color,color,transform] duration-100 active:scale-[0.985] motion-reduce:active:scale-100 bg-accent-solid text-accent-foreground border border-transparent shadow-sm dark:shadow-none hover:bg-accent-solid-hover px-4 py-2 text-sm rounded-md cursor-pointer"
            >
              <span className="inline-flex mr-2"><Wallet size={16} /></span>
              Open wallet app
            </a>
            <Button type="secondary" onClick={onReset}>Cancel</Button>
          </div>
        </Card>
      );
    case "idle":
    case "starting":
    case "unsupported":
      if (state.kind === "idle" && latest?.status === "verified") return <VerifiedPanel result={latest} />;
      return (
        <Card className="p-6 space-y-4">
          <h2 className="text-lg font-semibold text-on-surface">Use the ID in your phone&apos;s wallet</h2>
          <p className="text-sm text-on-surface-secondary">
            {supportsWallet
              ? "Your phone will ask you to confirm before anything is shared."
              : "Scan a QR code with your phone to share your ID from your wallet app."}
          </p>
          {supportsWallet ? (
            <Button
              type="primary"
              icon={<Wallet size={16} />}
              loading={state.kind === "starting"}
              onPointerDown={onPrefetch}
              onClick={onVerifyWithWallet}
            >
              Verify with my phone&apos;s wallet
            </Button>
          ) : (
            <Button type="primary" icon={<QrCode size={16} />} loading={state.kind === "starting"} onClick={onShowQrCode}>
              Show QR code
            </Button>
          )}
        </Card>
      );
  }
}
