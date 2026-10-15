"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import identityVerificationService from "@/services/identityVerification.service";
import { isApiError } from "@/lib/utils/apiErrors";
import type {
  ClientIdentityVerification,
  PortalIdentityStatus,
  StartedVerification,
  VerificationResult,
} from "@/types/identityVerification";

/** How often the QR flow asks whether the wallet app has answered. */
const POLL_INTERVAL_MS = 2000;
/** How many polls before the QR flow gives up: three minutes at 2 s. */
const MAX_POLLS = 90;

export type IdentityFlowState =
  | { kind: "idle" }
  /** The backend is creating the verification. */
  | { kind: "starting" }
  /** The phone's wallet sheet is open (Flow A). */
  | { kind: "wallet" }
  /** A QR code is on screen and the wallet app has not answered yet (Flow D). */
  | { kind: "qr"; walletUrl: string; qrDataUrl: string }
  /** The wallet answered and the backend is checking it. */
  | { kind: "verifying" }
  /** The backend's verdict: verified, failed or expired. */
  | { kind: "finished"; result: VerificationResult }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "timedOut" }
  | { kind: "error"; status: number | null; code: string | null };

/**
 * Whether this browser can open the phone wallet. Safari 17.4+ and Chrome 141+
 * expose a global `DigitalCredential`; every other browser gets the QR flow.
 */
function browserSupportsWallet(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { DigitalCredential?: unknown }).DigitalCredential !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.get === "function"
  );
}

const noopSubscribe = () => () => {};

function errorState(error: unknown): IdentityFlowState {
  if (isApiError(error)) return { kind: "error", status: error.status ?? null, code: error.code ?? null };
  return { kind: "error", status: null, code: null };
}

/**
 * The wallet's answer, as the string `complete` sends. Safari resolves `data`
 * to an object for org-iso-mdoc, so anything but a string is serialized whole.
 * The value is passed straight to the backend and never kept, logged or shown.
 */
function credentialPayload(credential: DigitalCredential): string {
  return typeof credential.data === "string" ? credential.data : JSON.stringify(credential.data);
}

function isCancellation(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "NotAllowedError" || name === "AbortError";
}

interface Options {
  lawFirmId: string;
  /** The portal's active client record, sent exactly as every other portal call sends it. */
  clientRecordId?: string | null;
  /** Called once with the backend's verdict, so the caller can refresh what it shows. */
  onFinished?: (result: VerificationResult) => void;
}

/**
 * Drives one identity verification from the client portal.
 *
 * Flow A (`mdoc_dcapi`): iOS Safari only opens the wallet when
 * `navigator.credentials.get()` runs inside the user's gesture, so the page
 * calls `prefetch()` on pointerdown to start the backend request early and
 * `verifyWithWallet()` on click, which only awaits that already-running request
 * before opening the wallet.
 *
 * Flow D (`w3c_openid4vp`): `showQrCode()` renders the wallet link as a QR and
 * polls every 2 s for up to three minutes. Every async continuation checks the
 * run it belongs to, so a reset or an unmount stops the loop and drops any
 * answer still in flight.
 */
export function useIdentityVerification({ lawFirmId, clientRecordId, onFinished }: Options) {
  const [state, setState] = useState<IdentityFlowState>({ kind: "idle" });
  // The server snapshot is `false`, so the server render and the first client
  // render agree and the wallet button never causes a hydration mismatch.
  const supportsWallet = useSyncExternalStore(noopSubscribe, browserSupportsWallet, () => false);

  const runRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prefetchRef = useRef<Promise<StartedVerification> | null>(null);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  useEffect(() => () => {
    runRef.current += 1;
    stopPolling();
  }, [stopPolling]);

  const finish = useCallback((result: VerificationResult) => {
    setState({ kind: "finished", result });
    onFinishedRef.current?.(result);
  }, []);

  const startWalletRequest = useCallback(
    () => identityVerificationService.start(lawFirmId, "mdoc_dcapi", clientRecordId),
    [lawFirmId, clientRecordId],
  );

  /** Start the backend request on pointerdown, ahead of the click. */
  const prefetch = useCallback(() => {
    if (!browserSupportsWallet() || prefetchRef.current) return;
    const pending = startWalletRequest();
    // The click awaits this and reports a failure; this only keeps an early
    // rejection from surfacing as unhandled before the click arrives.
    pending.catch(() => {});
    prefetchRef.current = pending;
  }, [startWalletRequest]);

  const verifyWithWallet = useCallback(async () => {
    if (!browserSupportsWallet()) {
      setState({ kind: "unsupported" });
      return;
    }
    stopPolling();
    const run = ++runRef.current;
    const pending = prefetchRef.current ?? startWalletRequest();
    prefetchRef.current = null;
    setState({ kind: "starting" });

    let started: StartedVerification;
    try {
      started = await pending;
    } catch (error) {
      if (run === runRef.current) setState(errorState(error));
      return;
    }
    if (run !== runRef.current) return;

    setState({ kind: "wallet" });
    let credential: DigitalCredential | null;
    try {
      credential = (await navigator.credentials.get({
        digital: { requests: [{ protocol: "org-iso-mdoc", data: started.request }] },
        mediation: "required",
      })) as DigitalCredential | null;
    } catch (error) {
      if (run !== runRef.current) return;
      setState(isCancellation(error) ? { kind: "cancelled" } : { kind: "error", status: null, code: "WALLET_ERROR" });
      return;
    }
    if (run !== runRef.current) return;
    if (!credential) {
      setState({ kind: "cancelled" });
      return;
    }

    setState({ kind: "verifying" });
    try {
      const result = await identityVerificationService.complete(
        lawFirmId,
        started.verificationId,
        credentialPayload(credential),
        clientRecordId,
      );
      if (run === runRef.current) finish(result);
    } catch (error) {
      if (run === runRef.current) setState(errorState(error));
    }
  }, [lawFirmId, clientRecordId, startWalletRequest, stopPolling, finish]);

  const showQrCode = useCallback(async () => {
    stopPolling();
    const run = ++runRef.current;
    setState({ kind: "starting" });

    let verificationId: string;
    let walletUrl: string;
    let qrDataUrl: string;
    try {
      const started = await identityVerificationService.start(lawFirmId, "w3c_openid4vp", clientRecordId);
      const url = (started.request as { walletUrl?: unknown } | null)?.walletUrl;
      if (typeof url !== "string" || !url) throw new Error("The verification did not include a wallet link.");
      verificationId = started.verificationId;
      walletUrl = url;
      qrDataUrl = await QRCode.toDataURL(walletUrl, { margin: 1, width: 240 });
    } catch (error) {
      if (run === runRef.current) setState(errorState(error));
      return;
    }
    if (run !== runRef.current) return;
    setState({ kind: "qr", walletUrl, qrDataUrl });

    let polls = 0;
    const tick = async () => {
      pollTimerRef.current = null;
      if (run !== runRef.current) return;
      polls += 1;
      try {
        const result = await identityVerificationService.poll(lawFirmId, verificationId, clientRecordId);
        if (run !== runRef.current) return;
        if (result && result.status !== "pending") {
          finish(result);
          return;
        }
      } catch (error) {
        if (run === runRef.current) setState(errorState(error));
        return;
      }
      if (polls >= MAX_POLLS) {
        setState({ kind: "timedOut" });
        return;
      }
      pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [lawFirmId, clientRecordId, stopPolling, finish]);

  /** Abandon whatever is running and return to the start, for a retry. */
  const reset = useCallback(() => {
    runRef.current += 1;
    stopPolling();
    prefetchRef.current = null;
    setState({ kind: "idle" });
  }, [stopPolling]);

  return { state, supportsWallet, prefetch, verifyWithWallet, showQrCode, reset };
}

/** The cache key of the portal's identity status, shared by the identity page and the home card. */
export function identityStatusQueryKey(lawFirmId: string, clientRecordId: string | null | undefined) {
  return ["identityStatus", lawFirmId, clientRecordId ?? null] as const;
}

/** The portal's read: whether verification is set up, and this client's latest result. */
export function useIdentityStatus(lawFirmId: string, clientRecordId: string | null | undefined, enabled = true) {
  return useQuery<PortalIdentityStatus>({
    queryKey: identityStatusQueryKey(lawFirmId, clientRecordId),
    queryFn: () => identityVerificationService.getPortalStatus(lawFirmId, clientRecordId),
    enabled: enabled && !!lawFirmId,
  });
}

/** The firm's read of one client's verification, for the client detail header. */
export function useClientIdentityVerification(lawFirmId: string, clientId: string, enabled = true) {
  return useQuery<ClientIdentityVerification>({
    queryKey: ["clientIdentityVerification", lawFirmId, clientId],
    queryFn: () => identityVerificationService.getClientVerification(lawFirmId, clientId),
    enabled: enabled && !!lawFirmId && !!clientId,
  });
}
