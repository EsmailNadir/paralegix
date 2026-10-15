# Login

The Paralegix login page (`/login`) is the entry point for all users, both firm members and clients. It supports email/password authentication and OAuth via Google and Microsoft.

## Sign-In Methods

### Email & Password

1. Enter your **email address** and **password**.
2. Click **Sign In**.

If your credentials are correct, you'll be redirected to your dashboard (firm members) or the client portal (clients), depending on your account type.

::: info Email Verification
If you signed up with email/password and haven't verified your email yet, you'll be redirected to `/verify-email` instead of the dashboard. Check your inbox for a verification link.
:::

### Google

Click **Google** to sign in with your Google account via OAuth popup. If this is your first time signing in with Google, you'll be taken to `/complete-registration` to select your account type.

### Microsoft

Click **Microsoft** to sign in with your Microsoft account via OAuth popup. First-time Microsoft sign-ins also go through `/complete-registration`.

::: tip OAuth accounts are always verified
Google and Microsoft sign-ins bypass the email verification step, since your email is considered verified by the provider.
:::

## Forgot Password

If you've forgotten your password:

1. Click **Forgot password?** (next to the Password field).
2. Enter your email address.
3. Click **Send Reset Email**.

A password reset link will be sent to your inbox. Check your spam folder if you don't see it within a few minutes.

::: info
Forgot password is only available for email/password accounts. If you signed up with Google or Microsoft, sign in using that provider instead.
:::

## Post-Login Redirects

After a successful sign-in, the app determines where to send you:

| Condition | Redirect |
|---|---|
| Email not verified | `/verify-email` |
| Registration not complete (OAuth) | `/complete-registration` |
| Deep-link redirect stored | The originally requested URL |
| Default | `/dashboard` (firm) or `/client/...` (client) |

## Don't Have an Account?

Click **Sign up** at the bottom of the login page to create a new account at `/register`.

If you were invited to join a law firm or client portal, use the link in your invitation email. Do not use the standard sign-up flow.
