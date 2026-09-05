# kubitor

**A monitoring dashboard for Kubernetes that is already full the first time you open it.**

Seeing what a small cluster is doing usually costs an afternoon: Prometheus, an operator to
run it, node-exporter, kube-state-metrics, Grafana, and then dashboards to import and repair.
kubitor is one server, one dashboard and an optional agent. It reads the cluster you already
have, works out what is installed, and shows the screens that match.

Bare k3s works out of the box. A cluster running Traefik gets its routers and its access log
as well — not on a separate screen, but as more columns and more detail on the screens that
were already there.

> **Status: early development.** It runs a real four-node cluster daily, the parts described
> below are the parts that exist, and the interface still changes between commits.

---

## What you get

**Overview** — how loaded the cluster is against what it actually has (CPU weighted by the
size of each machine, memory and disk with their totals beside them), pods by state with the
ones that are not running linked to the workloads behind them, an hour of traffic, and a short
list of what needs attention: nodes not ready, pods in `CrashLoopBackOff`, agents gone quiet,
warnings in the last hour.

**Nodes** — a machine per page. What it is doing now, and what it is: processor model,
topology and cache totals, memory type and speed as the firmware reports it, every mounted
filesystem, every drive with its PCIe link and throughput, GPUs with core and memory clocks,
and temperatures shown beside the part they belong to rather than in a list of their own.

**Workloads, Namespaces, Events** — pods with the status `kubectl` would print, including the
container reason a phase cannot express (`CrashLoopBackOff`, `ImagePullBackOff`,
`Unschedulable`); namespaces summarized; the cluster's own events, filtered.

**Routes and HTTP traffic** — every address the cluster answers on, whichever ingress
publishes it, and the requests that reached them. Where Traefik is installed, its matcher
expression rides along in the same table.

**Everything is exportable.** Any table, as JSON or CSV, with the filters currently applied —
the export receives exactly the query the screen is showing.

**Search is a first-class citizen.** `⌘K` across the cluster, plus a filter bar on every list.
Filter state lives in the URL, so a filtered view is a link you can send to somebody.

## How it decides what to show

Integrations probe the cluster and report `present`, `absent` or `unknown`. `unknown` matters:
an RBAC denial must never be reported as "you don't run that", because silent blindness is
worse than a visible error. Every verdict carries a sentence explaining the evidence, and you
can override any of them.

What they collect is normalized into vendor-neutral **facets** — `nodes`, `workloads`,
`events`, `http.routes`, `http.access`, `host.hardware` — so the screens are the same whichever
product is installed underneath. Vendor-specific detail travels alongside and is rendered where
it belongs. The dashboard builds its own navigation from what the server reports, so a bare
cluster shows a short menu and a full one shows more.

## Installing

You need a Kubernetes cluster, an ingress controller, and one `ReadWriteOnce` volume.

```bash
git clone https://github.com/ridanit-ruma/kubitor && cd kubitor

# 1. The values that belong to your cluster, not to kubitor
cp -r examples/overlay examples/my-cluster
$EDITOR examples/my-cluster/kustomization.yaml    # ingress host; storage class if not the default

# 2. The session secret, and the first password
kubectl create namespace kubitor
kubectl -n kubitor create secret generic kubitor-server \
  --from-literal=KUBITOR_SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=KUBITOR_ADMIN_INITIAL_PASSWORD="$(openssl rand -hex 12)"

# 3. Apply
kubectl apply -k examples/my-cluster
```

Open the host you configured and sign in as `admin` with that password; kubitor asks you to
change it before it lets you in anywhere else.

`deploy/` ships with **no cluster's values in it**: no ingress class, so the cluster's default
IngressClass takes the Ingress; no storage class, so the volume comes from the default; and a
placeholder host. Keep your own values in an overlay rather than editing `deploy/` — upgrading
is then a change of one line with nothing to merge. Put the overlay wherever you like,
including a private repository, and point its `resources:` at this repository's `deploy/` by
path or by URL. Flux and Argo read the same directory.

A NetworkPolicy that admits only your ingress controller is in `deploy/networkpolicy.yaml`,
left out of the default install because it has to name the namespace that controller runs in
and a wrong guess makes the dashboard unreachable with nothing in any log to explain it. The
overlay shows how to add it.

### The agent is optional

Install it and node pages gain host RAM, CPU and GPU clocks, memory modules, drives,
filesystems and temperatures — none of which the Kubernetes API can answer. Leave it out and
everything else still works.

It needs no secret. Each pod presents a projected service-account token naming the node it runs
on, and the server verifies that claim against the cluster's public keys, so a compromised
agent cannot report on another machine's behalf.

It runs as `nobody` with every capability dropped. A short-lived init container running as root
copies one file — the firmware's SMBIOS table, which is the only place the memory type is
truthfully recorded — and then exits. Delete that container if your cluster will not admit it;
the agent starts anyway and falls back to what the kernel exposes.

### What it asks the cluster for

Read-only, and only what the screens use: `get`/`list` on nodes, pods, namespaces, events,
services, endpoints, deployments, daemonsets, statefulsets, ingresses, ingress classes, storage
classes and CRDs; `get` on `nodes/proxy` for kubelet statistics and on `pods/log` for the
ingress access log. Nothing is created, changed or deleted. kubitor cannot act on your cluster,
by construction.

### Configuration

| Variable | Default | |
|---|---|---|
| `KUBITOR_SESSION_SECRET` | — | **Required.** 32 characters or more |
| `KUBITOR_ADMIN_INITIAL_PASSWORD` | — | First install only; the admin must change it |
| `KUBITOR_DB_KIND` | `sqlite` | `sqlite` or `postgres` |
| `KUBITOR_SQLITE_PATH` | `/var/lib/kubitor/kubitor.db` | |
| `KUBITOR_POSTGRES_URL` | — | Required when `KUBITOR_DB_KIND=postgres` |
| `KUBITOR_SESSION_TTL_HOURS` | `12` | |
| `KUBITOR_TRUSTED_PROXY_HEADER` | `x-forwarded-for` | The header carrying the real client IP |
| `KUBITOR_COOKIE_SECURE` | `true` | Set `false` only for plain-HTTP development |
| `KUBITOR_AGENT_SERVICE_ACCOUNT` | `kubitor-agent` | The only service account whose token may report host metrics |

SQLite on one volume is the default and is enough for a cluster of this size; PostgreSQL is
there for people who would rather not have a stateful volume.

## Security

- Sessions are a JWT in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie carrying a session id
  checked against a server-side row, so signing out revokes immediately. Never `localStorage`.
- The socket carries data rather than a nudge, so it revalidates the session on **every** push
  — a logged-out tab stops receiving within one second.
- Login lockout keys on the client IP, never on the username: locking an account by name is a
  denial-of-service primitive. Behind a proxy that offers a header a client cannot append to —
  Cloudflare's `cf-connecting-ip`, say — name it in `KUBITOR_TRUSTED_PROXY_HEADER`.
- CSV exports escape formula injection and cap their row count.

## Built with

TypeScript throughout. [NestJS](https://nestjs.com) on the server,
[Next.js](https://nextjs.org) and [shadcn/ui](https://ui.shadcn.com) in the dashboard,
[Kysely](https://kysely.dev) over SQLite or PostgreSQL, and a small Node agent that reads
`/proc` and `/sys` directly.

Live figures arrive over a WebSocket once a second. The database takes one reading every
fifteen — three separate cadences, because pushing at the storage rate makes a dashboard look
dead, and storing at the push rate destroys the disk.

## Developing

```bash
pnpm install
pnpm test          # agent, shared, client, server
pnpm typecheck
pnpm lint

pnpm --filter @kubitor/client dev    # the dashboard, against a server on :3001
```

The server reads a kubeconfig when it is not running in a cluster, and stores into SQLite at
`KUBITOR_SQLITE_PATH` — point that somewhere writable and give it a
`KUBITOR_SESSION_SECRET` to run it outside a container.

Integrations are first-party modules in `server/src/integrations/`: no plugin runtime, no
sandbox, no signature verification. A new one is a pull request, and testing it needs a fake
Kubernetes client and an assertion on what it emits — no framework harness, no database.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
