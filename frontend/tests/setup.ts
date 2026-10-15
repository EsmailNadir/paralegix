import "@testing-library/jest-dom";
import "cross-fetch/polyfill";
import React from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { TextDecoder, TextEncoder } from "util";
import { clearImmediate, setImmediate } from "timers";

if (!(globalThis as any).TextEncoder) {
  (globalThis as any).TextEncoder = TextEncoder;
}
if (!(globalThis as any).TextDecoder) {
  (globalThis as any).TextDecoder = TextDecoder;
}
if (!(globalThis as any).setImmediate) {
  (globalThis as any).setImmediate = setImmediate;
}
if (!(globalThis as any).clearImmediate) {
  (globalThis as any).clearImmediate = clearImmediate;
}
// jsdom's Blob implements none of the reading methods the platform has had
// since 2019. Uploads read a picked file through `Blob.slice().arrayBuffer()`
// to fingerprint it without holding the whole document in memory, and the
// FileReader fallback they carry for old Safari runs on macrotasks, so under
// `jest.useFakeTimers()` it never resolves and the upload appears to hang.
// Supplying the method every target browser has keeps the specs on the same
// code path as production.
if (typeof Blob !== "undefined" && !(Blob.prototype as any).arrayBuffer) {
  (Blob.prototype as any).arrayBuffer = function arrayBuffer(this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}
if (!(globalThis as any).matchMedia) {
  const matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  });
  (globalThis as any).matchMedia = matchMedia;
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: matchMedia,
    });
  }
}
if (!(globalThis as any).ResizeObserver) {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as any).ResizeObserver = ResizeObserverMock;
  if (typeof window !== "undefined") {
    (window as any).ResizeObserver = ResizeObserverMock;
  }
}
// jsdom has no IntersectionObserver, and no layout for one to report on. The stub
// captures the callback so a test can drive visibility itself
// (`__lastIntersectionCallback`), which is the only way to exercise a
// scroll-position-dependent component here.
if (!(globalThis as any).IntersectionObserver) {
  class IntersectionObserverMock {
    constructor(callback: unknown) {
      (globalThis as any).__lastIntersectionCallback = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  (globalThis as any).IntersectionObserver = IntersectionObserverMock;
  if (typeof window !== "undefined") {
    (window as any).IntersectionObserver = IntersectionObserverMock;
  }
}
// jsdom does not implement layout, so scroll helpers used by components (e.g.
// the shared Dropdown scrolling its active option into view) are undefined.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// Same gap on Range: jsdom implements the object but none of its layout
// methods, so anything reading a caret rectangle (the rich-text editors ask
// where the cursor is to place their toolbars) throws instead of measuring.
// A zero rect is the honest answer in a browser with no layout.
if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  const emptyRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    toJSON() { return this; },
  }) as DOMRect;
  Range.prototype.getBoundingClientRect = emptyRect;
  Range.prototype.getClientRects = function getClientRects() {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
}

jest.setTimeout(30000);

// ---------------------------------------------------------------------------
// Mock: next/navigation
// ---------------------------------------------------------------------------
// One router per test file, as Next's `useRouter` returns one object from
// context. A fresh object per call changes the `router` dependency of every
// effect that lists it, so those effects re-run on each render.
jest.mock("next/navigation", () => {
  const router = {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  };
  return {
    useRouter: () => router,
    useParams: () => ({ lawFirmId: "test-law-firm-id" }),
    usePathname: () => "/dashboard",
    useSearchParams: () => new URLSearchParams(),
  };
});

// ---------------------------------------------------------------------------
// Mock: next/image
// ---------------------------------------------------------------------------
jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) =>
    React.createElement("img", props),
}));

// ---------------------------------------------------------------------------
// Mock: firebase/auth
// ---------------------------------------------------------------------------
jest.mock("firebase/auth", () => ({
  getAuth: jest.fn(),
  // The callback fires ASYNCHRONOUSLY, matching real Firebase.
  //
  // It used to fire synchronously, which broke any code that unsubscribes from
  // inside its own callback -- `waitForAuthReady` in `src/lib/utils/auth.ts` does
  // exactly that, and calling it under this mock threw "Cannot access
  // 'unsubscribe' before initialization" from the temporal dead zone. Real
  // Firebase never delivers the first callback before `onAuthStateChanged`
  // returns, so the synchronous mock was modelling something that cannot happen
  // and blocking every spec that drives a real service.
  onAuthStateChanged: jest.fn((_auth, cb) => {
    queueMicrotask(() => cb({
      uid: "test-uid",
      email: "testuser@example.com",
      displayName: "Test User",
      emailVerified: true,
      getIdToken: jest.fn().mockResolvedValue("mock-token"),
    }));
    return jest.fn(); // unsubscribe
  }),
  signInWithEmailAndPassword: jest.fn().mockResolvedValue({}),
  createUserWithEmailAndPassword: jest.fn().mockResolvedValue({}),
  signOut: jest.fn().mockResolvedValue(undefined),
  // Added alongside the `currentUser` above. `auth.service.updateName` calls it
  // before its API request, so without it that method threw
  // "updateProfile is not a function" and nothing past the guard was reachable.
  updateProfile: jest.fn().mockResolvedValue(undefined),
  GoogleAuthProvider: Object.assign(
    jest.fn().mockImplementation(() => ({
      addScope: jest.fn(),
    })),
    {
      credentialFromResult: jest.fn(() => ({})),
    },
  ),
  OAuthProvider: Object.assign(
    jest.fn().mockImplementation(() => ({
      addScope: jest.fn(),
      setCustomParameters: jest.fn(),
    })),
    {
      credentialFromResult: jest.fn(() => ({})),
    },
  ),
  signInWithPopup: jest.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/firebase/config
// ---------------------------------------------------------------------------
jest.mock("@/lib/firebase/config", () => ({
  // `auth` carries a `currentUser`, not an empty object.
  //
  // It used to be `{}`, and that silently made a whole class of test
  // impossible: every service method guarded by `auth.currentUser` took its
  // not-signed-in branch and returned early, so `auth.service`'s API calls were
  // unreachable and any spec written against them failed with "No authenticated
  // user" rather than exercising anything.
  //
  // The identity matches the rest of the harness: the same uid the AuthContext
  // mock below uses, and a token that agrees with the `Bearer mock-token` the
  // fetch wrapper attaches. A spec that needs a SIGNED-OUT caller overrides this
  // per file.
  auth: {
    currentUser: {
      uid: "test-uid",
      email: "testuser@example.com",
      displayName: "Test User",
      emailVerified: true,
      providerData: [],
      getIdToken: jest.fn().mockResolvedValue("mock-token"),
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock: AuthContext
// ---------------------------------------------------------------------------
const mockAuthValue = {
  user: {
    uid: "test-uid",
    email: "testuser@example.com",
    displayName: "Test User",
    emailVerified: true,
    getIdToken: jest.fn().mockResolvedValue("mock-token"),
  },
  loading: false,
  signIn: jest.fn().mockResolvedValue({}),
  signUp: jest.fn().mockResolvedValue({}),
  signOut: jest.fn().mockResolvedValue(undefined),
};

// Auth is a hook, not a context: `useAuth` subscribes to Firebase directly, so
// there is no provider to stub out. Mocking the hook keeps components that read
// the signed-in user (the time-entry timekeeper default, for one) off the real
// Firebase SDK.
jest.mock("@/hooks/useAuth", () => ({
  __esModule: true,
  useAuth: () => mockAuthValue,
}));

// ---------------------------------------------------------------------------
// Mock: LawFirmContext
// ---------------------------------------------------------------------------
const mockLawFirmValue = {
  lawFirm: {
    id: "test-law-firm-id",
    name: "Test Law Firm LLP",
    ownerId: "test-uid",
    createdAt: "2025-01-01T00:00:00.000Z",
  },
  refetchLawFirm: jest.fn().mockResolvedValue(undefined),
};

jest.mock("@/contexts/LawFirmContext", () => ({
  __esModule: true,
  useLawFirm: () => mockLawFirmValue,
  LawFirmContext: {
    Provider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  },
}));

// ---------------------------------------------------------------------------
// Mock: PermissionsContext
// ---------------------------------------------------------------------------
const mockPermissionsValue = {
  loading: false,
  lawFirmId: "test-law-firm-id",
  member: {
    id: "test-uid",
    userId: "test-uid",
    name: "Test User",
    email: "testuser@example.com",
    role: "owner",
    isOwner: true,
  },
  isOwner: true,
  permissions: ["*"],
  // Typed to match the real context signature, so a test can override these with
  // a predicate over the requested permission (several do) instead of only being
  // able to swap in another zero-argument function.
  hasPermission: (() => true) as (permission: string) => boolean,
  hasAnyPermission: (() => true) as (permissions: string[]) => boolean,
  hasAllPermissions: (() => true) as (permissions: string[]) => boolean,
  refresh: jest.fn().mockResolvedValue(undefined),
};

jest.mock("@/contexts/PermissionsContext", () => ({
  __esModule: true,
  usePermissions: () => mockPermissionsValue,
  PermissionsProvider: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

// ---------------------------------------------------------------------------
// Mock: NavigationContext
// ---------------------------------------------------------------------------
jest.mock("@/contexts/NavigationContext", () => ({
  __esModule: true,
  useNavigation: () => ({
    navigate: jest.fn(),
    isNavigating: false,
  }),
}));

// ---------------------------------------------------------------------------
// Mock: Service files — each exported function returns resolved empty data
// ---------------------------------------------------------------------------
const shouldMockFrontendServices = process.env.MOCK_FRONTEND_SERVICES !== "0";
const makeServiceMock = () =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "__esModule") return true;
        if (prop === "default") return makeServiceMock();
        return jest.fn().mockResolvedValue({});
      },
    },
);

if (shouldMockFrontendServices) {
  jest.mock("@/services/admin.service", () => makeServiceMock());
  jest.mock("@/services/auth.service", () => makeServiceMock());
  jest.mock("@/services/billing.service", () => makeServiceMock());
  jest.mock("@/services/matterEvents.service", () => makeServiceMock());
  jest.mock("@/services/matters.service", () => makeServiceMock());
  jest.mock("@/services/chargeCodes.service", () => makeServiceMock());
  jest.mock("@/services/client-portal.service", () => makeServiceMock());
  jest.mock("@/services/clients.service", () => makeServiceMock());
  jest.mock("@/services/calendarEvents.service", () => makeServiceMock());
  jest.mock("@/services/courts.service", () => makeServiceMock());
  jest.mock("@/services/files.service", () => makeServiceMock());
  jest.mock("@/services/identityVerification.service", () => makeServiceMock());
  jest.mock("@/services/googleCalendarSync.service", () => ({
    __esModule: true,
    GOOGLE_CALENDAR_RECONNECT_EVENT: "paralegix-google-calendar-reconnect",
    GOOGLE_CALENDAR_RECONNECT_CODE: "GOOGLE_CALENDAR_RECONNECT_REQUIRED",
    GoogleCalendarReconnectRequiredError: class GoogleCalendarReconnectRequiredError extends Error {},
    isGoogleCalendarReconnectRequiredError: () => false,
    GoogleCalendarSync: {
      checkGoogleAuth: jest.fn().mockResolvedValue({ authenticated: false }),
      initParalegixCalendar: jest.fn().mockResolvedValue({ success: true }),
      syncFromGoogle: jest.fn().mockResolvedValue({ success: true }),
    },
  }));
  jest.mock("@/services/lawfirm.service", () => makeServiceMock());
  jest.mock("@/services/messages.service", () => makeServiceMock());
  jest.mock("@/services/outlookCalendarSync.service", () => ({
    __esModule: true,
    OutlookCalendarSync: {
      initParalegixCalendar: jest.fn().mockResolvedValue({ success: true }),
      syncFromOutlook: jest.fn().mockResolvedValue({ success: true }),
    },
  }));
  jest.mock("@/services/practiceArea.service", () => makeServiceMock());
  jest.mock("@/services/requestDeduplicator", () => ({
    __esModule: true,
    default: { execute: jest.fn().mockResolvedValue({}) },
    requestDeduplicator: { execute: jest.fn().mockResolvedValue({}) },
  }));
  jest.mock("@/services/roles.service", () => makeServiceMock());
  jest.mock("@/services/settings.service", () => makeServiceMock());
  jest.mock("@/services/signatures.service", () => makeServiceMock());
  jest.mock("@/services/tasks.service", () => makeServiceMock());
  jest.mock("@/services/templates.service", () => makeServiceMock());
  jest.mock("@/services/trust.service", () => makeServiceMock());
  jest.mock("@/services/users.service", () => makeServiceMock());
}

// ---------------------------------------------------------------------------
// Mock: @/lib/utils/tokenRefreshHandler
// ---------------------------------------------------------------------------
jest.mock("@/lib/utils/tokenRefreshHandler", () => ({
  resetRefreshState: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: isomorphic-dompurify
// ---------------------------------------------------------------------------
// `sanitizeRichHtml` imports isomorphic-dompurify, whose server-side (jsdom)
// branch pulls in ESM dependencies Jest cannot transform. jsdom already
// provides a `window`, so the browser build of DOMPurify sanitizes the same
// way it does in production.
jest.mock("isomorphic-dompurify", () => require("dompurify"));

// ---------------------------------------------------------------------------
// Mock: PDF preview components
// ---------------------------------------------------------------------------
// These wrap `react-pdf`, which ships as ESM and pulls in `pdfjs-dist` plus a
// web worker — none of which Jest can parse or exercise under jsdom. Any test
// that renders a component importing one of them (e.g. ConversationView →
// FilePreviewModal → PdfPreview) would otherwise fail to load the module tree.
// Stub them out; no test renders an actual PDF.
jest.mock("@/components/filesComp/PdfPreview", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/signaturesComp/PDFPageViewer", () => ({
  __esModule: true,
  default: () => null,
}));

// ---------------------------------------------------------------------------
// Helper: renderWithProviders
// ---------------------------------------------------------------------------
export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  function AllProviders({ children }: { children: React.ReactNode }) {
    return React.createElement(React.Fragment, null, children);
  }

  return render(ui, { wrapper: AllProviders, ...options });
}

// Re-export everything from testing-library for convenience
export * from "@testing-library/react";

// Export mock values so individual tests can override them
export {
  mockAuthValue,
  mockLawFirmValue,
  mockPermissionsValue,
};
