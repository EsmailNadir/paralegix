import type { Metadata } from "next";
import RegisterClient from "./RegisterClient";
import JsonLd from "@/components/marketingComp/JsonLd";
import { breadcrumbSchema } from "@/lib/seo/structuredData";

const DESCRIPTION =
  "Create your Paralegix account and set up your law firm in minutes. Free Starter plan, no credit card required.";

export const metadata: Metadata = {
  title: "Create your account",
  description: DESCRIPTION,
  alternates: { canonical: "/register" },
  openGraph: {
    title: "Create your account | Paralegix",
    description: DESCRIPTION,
    url: "/register",
  },
};

export default function RegisterPage() {
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          ...breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Create your account", path: "/register" },
          ]),
        }}
      />
      <RegisterClient />
    </>
  );
}
