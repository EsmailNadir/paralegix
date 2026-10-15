"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import LoadingSpinner from "@/components/LoadingSpinner";
import { isEmailVerified } from "@/lib/utils/emailVerification";

export default function DashboardLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    } else if (!loading && user && !isEmailVerified(user)) {
      router.push("/verify-email");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <LoadingSpinner fullPage />
    );
  }

  if (!user || !isEmailVerified(user)) return null;

  return (
    <div className="min-h-screen">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <main id="main-content">
        {children}
      </main>
    </div>
  );
}
