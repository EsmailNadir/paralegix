import '../styles/global.css';
import type { Metadata } from "next";
import { Geist, Geist_Mono, Barlow, Instrument_Serif, Newsreader, Plus_Jakarta_Sans } from "next/font/google";
import ConsoleNoiseFilter from "@/components/ConsoleNoiseFilter";
import AnalyticsSession from "@/components/AnalyticsSession";
import CookieNotice from "@/components/ui/CookieNotice";
import JsonLd from "@/components/marketingComp/JsonLd";
import { organizationSchema, websiteSchema } from "@/lib/seo/structuredData";
import { SITE_URL, IS_INDEXABLE } from "@/lib/seo/site";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const barlow = Barlow({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
});

// Marketing-site typefaces (public pages only): editorial serif + UI sans.
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

const plusJakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  // 800 carries the logo wordmark in ParalegixLogo, so it has to ship even
  // though no marketing body copy uses it.
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  // Resolves the relative URLs below (and every page's canonical) against the
  // deployment's own origin instead of emitting them relative.
  metadataBase: new URL(SITE_URL),
  title: {
    // Pages set only their own name; the suffix is applied here so it can never
    // drift page to page. `default` covers routes that set no title at all.
    default: "Paralegix | Legal practice management software",
    template: "%s | Paralegix",
  },
  description:
    "Paralegix unifies matter intake, documents, calendaring, time tracking, trust accounting, and billing into one workspace for law firms.",
  applicationName: "Paralegix",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Paralegix",
    url: "/",
    title: "Paralegix | Legal practice management software",
    description:
      "Matter management, documents, calendaring, trust accounting, and billing for law firms, all in one workspace.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Paralegix | Legal practice management software",
    description:
      "Matter management, documents, calendaring, trust accounting, and billing for law firms, all in one workspace.",
  },
  // Staging and preview deployments serve identical pages to production; keeping
  // them out of the index is what stops them competing as duplicate content.
  robots: IS_INDEXABLE
    ? { index: true, follow: true }
    : { index: false, follow: false },
  icons: {
    icon: [
      {
        url: "/favicon/favicon.ico",
        rel: "shortcut icon",
      },
      {
        url: "/favicon/favicon-32x32.png",
        sizes: "32x32",
        type: "image/png",
      },
      {
        url: "/favicon/favicon-16x16.png",
        sizes: "16x16",
        type: "image/png",
      },
    ],
    apple: "/favicon/apple-touch-icon.png",
    other: [
      {
        rel: "manifest",
        url: "/favicon/site.webmanifest",
      },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('paralegix-theme');if(t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme:dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})()`,
          }}
        />
        <JsonLd
          data={{
            "@context": "https://schema.org",
            "@graph": [websiteSchema(), organizationSchema()],
          }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} ${barlow.variable} ${instrumentSerif.variable} ${newsreader.variable} ${plusJakarta.variable} antialiased bg-page text-on-surface`}>
        <ConsoleNoiseFilter />
        <AnalyticsSession />
        {children}
        <CookieNotice />
      </body>
    </html>
  );
}