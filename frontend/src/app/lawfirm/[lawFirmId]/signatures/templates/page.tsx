import { redirect } from 'next/navigation';

/**
 * The template library used to be a page of its own. It is now the Templates tab
 * of the signatures page; this route keeps links and bookmarks to the old one
 * working, carrying over any search term they were opened with.
 */
export default async function SigningTemplatesRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ lawFirmId: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { lawFirmId } = await params;
  const { q } = await searchParams;
  const search = Array.isArray(q) ? q[0] : q;

  const query = new URLSearchParams({ tab: 'templates' });
  if (search) query.set('q', search);

  redirect(`/lawfirm/${lawFirmId}/signatures?${query.toString()}`);
}
