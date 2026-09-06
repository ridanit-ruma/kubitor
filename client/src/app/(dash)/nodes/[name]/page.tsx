import { redirect } from 'next/navigation';

/**
 * The machine page moved to `/hosts/[name]`.
 *
 * One machine has one page whether or not Kubernetes has heard of it, and a
 * machine outside the cluster living under `/nodes` was a URL that lied. Links
 * already shared keep resolving.
 */
export default async function NodeDetailRedirect({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  redirect(`/hosts/${name}`);
}
