// The secure payment link's address: the no-login pay page for its token. One
// place builds it, so the request email, the firm's copy button and the
// reminders always point at the same page.
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

export function payLinkUrl(token: string): string {
  return `${FRONTEND_URL}/pay/${token}`;
}
