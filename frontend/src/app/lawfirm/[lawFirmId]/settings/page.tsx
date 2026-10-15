import { redirect } from 'next/navigation';

/**
 * The settings section has no landing page of its own -- only its tabs
 * (general, members, billing, ...) do. Without this, a bookmark or a typed
 * URL to the bare /settings path 404s instead of opening the first tab.
 */
export default async function SettingsIndexRedirect({
  params,
}: {
  params: Promise<{ lawFirmId: string }>;
}) {
  const { lawFirmId } = await params;
  redirect(`/lawfirm/${lawFirmId}/settings/general`);
}
