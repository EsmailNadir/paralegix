"use client";

import { useState } from "react";
import useFormFeedback from "@/hooks/useFormFeedback";
import authService from "@/services/auth.service";
import { getFirebaseErrorMessage } from "@/lib/utils/firebaseErrors";
import { isWhitelistedEmail } from "@/lib/utils/emailVerification";

interface Target {
  userType: "client" | "firm_member";
  onWhitelisted: () => void;
  onVerificationRequired: () => void;
  onOAuthRegistered: () => void;
  onOAuthExisting: () => void;
}

/** Credential validation and authentication shared by invitation registration forms. */
export default function useInvitationCredentials(target: Target) {
  const [formData, setFormData] = useState({ email: "", password: "", confirmPassword: "", name: "" });
  const feedback = useFormFeedback();
  const { setErrorMessage, setFieldError } = feedback;
  const [loadingMethod, setLoadingMethod] = useState<"" | "email" | "google" | "microsoft">("");
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [event.target.name]: event.target.value });
  };
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrorMessage("");
    if (formData.password !== formData.confirmPassword) {
      setFieldError("confirmPassword", "Passwords do not match");
      return;
    }
    if (formData.password.length < 6) {
      setFieldError("password", "Password must be at least 6 characters");
      return;
    }
    setLoadingMethod("email");
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      await authService.signUp(formData.email, formData.password, { name: formData.name, userType: target.userType });
      if (isWhitelistedEmail(formData.email)) {
        target.onWhitelisted();
        return;
      }
      try { await authService.sendVerificationEmail(); }
      catch (error) { console.error("Failed to send verification email:", error); }
      try { sessionStorage.setItem("verify-email-address", formData.email); } catch {}
      target.onVerificationRequired();
    } catch (error) {
      const message = getFirebaseErrorMessage(error, "Something went wrong. Please try again.");
      if (message) setErrorMessage(message);
    } finally { setLoadingMethod(""); }
  };
  const handleOAuth = async (provider: "google" | "microsoft") => {
    setLoadingMethod(provider);
    setErrorMessage("");
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      const result = provider === "google" ? await authService.signUpWithGoogle() : await authService.signUpWithMicrosoft();
      if (result.needsRegistration) {
        await authService.completeOAuthRegistration(target.userType);
        target.onOAuthRegistered();
      } else target.onOAuthExisting();
    } catch (error) {
      const message = getFirebaseErrorMessage(error, `${provider === "google" ? "Google" : "Microsoft"} signup failed. Please try again.`);
      if (message) setErrorMessage(message);
    } finally { setLoadingMethod(""); }
  };
  return { formData, setFormData, ...feedback, loadingMethod, handleChange, handleSubmit, handleGoogleSignup: () => handleOAuth("google"), handleMicrosoftSignup: () => handleOAuth("microsoft") };
}
