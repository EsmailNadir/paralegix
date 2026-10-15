import type { Metadata } from "next";
import LoginClient from "./LoginClient";
import JsonLd from "@/components/marketingComp/JsonLd";
import { breadcrumbSchema } from "@/lib/seo/structuredData";

const DESCRIPTION =
  "Sign in to Paralegix to manage your firm's matters, deadlines, documents, and billing.";

export const metadata: Metadata = {
  title: "Sign in",
  description: DESCRIPTION,
  alternates: { canonical: "/login" },
  openGraph: {
    title: "Sign in | Paralegix",
    description: DESCRIPTION,
    url: "/login",
  },
};

export default function LoginPage() {
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          ...breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Sign in", path: "/login" },
          ]),
        }}
      />
      <LoginClient />
    </>
  );
}
