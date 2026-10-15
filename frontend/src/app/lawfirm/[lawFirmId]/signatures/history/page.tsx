import { redirect } from 'next/navigation';

/**
 * The signing history used to be a page of its own, rendering the same list as
 * the signatures page with the search and filters switched on. The signatures
 * page now shows that list in full, so this route only exists to keep links and
 * bookmarks to the old one working.
 */
export default async function SigningHistoryRedirect({
  params,
}: {
  params: Promise<{ lawFirmId: string }>;
}) {
  const { lawFirmId } = await params;
  redirect(`/lawfirm/${lawFirmId}/signatures`);
}
