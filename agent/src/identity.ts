/**
 * What this machine calls itself when it reports.
 *
 * "Node" is the wrong word for a machine that is not one, and the agent now
 * runs on hosts outside the cluster as well as in a DaemonSet. The old variable
 * keeps working, so an existing deployment needs no change.
 *
 * The name is only what the machine *asks* to be called: the server files every
 * reading under the name its credential proves, so this cannot be used to
 * report on another machine's behalf.
 */
export function hostNameFrom(env: NodeJS.ProcessEnv, fallback: string): string {
  return env.KUBITOR_HOST_NAME ?? env.KUBITOR_NODE_NAME ?? fallback;
}
