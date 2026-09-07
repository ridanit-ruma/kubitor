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

Written and owned by **ruma** ([@ridanit-ruma](https://github.com/ridanit-ruma)), and released
under the **AGPL-3.0** — run it, modify it, and if you run a modified copy as a service for
other people, share your changes with them. See [Copyright and licence](#copyright-and-licence).

---

## What you get

**Overview** — how loaded the cluster is against what it actually has (CPU weighted by the
size of each machine, memory and disk with their totals beside them), pods by state with the
ones that are not running linked to the workloads behind them, an hour of traffic, and a short
list of what needs attention: nodes not ready, pods in `CrashLoopBackOff`, agents gone quiet,
warnings in the last hour.

**Nodes and Hosts** — a machine per page. What it is doing now, and what it is: processor model,
topology and cache totals, memory type and speed as the firmware reports it, every mounted
filesystem, every drive with its PCIe link and throughput, GPUs with core and memory clocks,
and temperatures shown beside the part they belong to rather than in a list of their own. The
same page serves a machine that is not in the cluster at all.

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

### Machines that are not nodes

A cluster is rarely the whole estate. The same agent runs on any Linux machine — a build box, a
NAS, a router — and reports to the same dashboard, where it appears under **Hosts** rather than
Nodes.

Such a machine has no service-account token to present, so it carries a static one instead:

1. **Settings → Agents → Issue a token.** Name the machine as you want it to appear. The token
   is shown once; only its hash is stored.
2. Unpack `kubitor-agent-<version>-linux-x64.tar.gz` from a release into `/opt/kubitor-agent`,
   put the three lines the dialog showed into `/etc/kubitor-agent.env` (mode `0600`), and
   install `agent.service` from the tarball. It needs Node on the host.
3. `systemctl enable --now kubitor-agent`.

The token is that machine's identity: one per machine, and revoking it stops the machine
reporting at once. A row claiming to be another machine is rewritten to the name its credential
proves, so one compromised agent cannot speak for the fleet.

The **Hosts** screen appears in the navigation only once a machine outside the cluster reports.
Until then it would list exactly what Nodes lists.

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
| `KUBITOR_BACKUP_S3_BUCKET` | — | Setting it turns backups on; see below |
| `KUBITOR_BACKUP_SCHEDULE` | `17 3 * * *` | Five-field cron |
| `KUBITOR_NOTIFY_MIN_SEVERITY` | `warning` | Nothing quieter than this is sent |
| `KUBITOR_PUBLIC_URL` | — | Where kubitor is reachable, for links in messages |
| `KUBITOR_HEARTBEAT_URL` | — | Pinged while alive, so silence is an alarm |
| `KUBITOR_AGENT_WITNESS_URL` | — | On the agent: where to report the server unreachable |

The agent takes `KUBITOR_SERVER_URL`, `KUBITOR_HOST_NAME` (the machine's name; `KUBITOR_NODE_NAME`
still works) and either `KUBITOR_AGENT_TOKEN` or a projected token mounted at
`/var/run/secrets/kubitor/token`.

SQLite on one volume is the default and is enough for a cluster of this size; PostgreSQL is
there for people who would rather not have a stateful volume.

## Alerts, and telling somebody

kubitor evaluates a short list of rules once a minute and keeps each result as a
thing with a name — `pod-crashloop` on `kubitor/server-7d9` — rather than a
count. That identity is what makes the difference between a notification and a
firehose: a condition that is still true is the same alert continuing, and
produces nothing.

Rules today: a node not ready, a pod crash-looping, a pod that cannot be
scheduled, a pod that cannot pull its image, an agent that stopped reporting,
and a backup that failed. The last two are kubitor watching itself.

**Nothing fires on the first evaluation.** A condition has to hold for more than
one pass before anybody hears about it, and be gone for more than one before it
is called recovered — so a pod that restarts once, or a node that blinks while
its kubelet restarts, never reaches a channel. **Recoveries are sent too.** A
channel that only ever reports bad news is one people learn to ignore, because
they cannot tell an outage from its aftermath.

```bash
KUBITOR_NOTIFY_DISCORD_WEBHOOK=https://discord.com/api/webhooks/...
KUBITOR_NOTIFY_SLACK_WEBHOOK=https://hooks.slack.com/services/...
KUBITOR_NOTIFY_TELEGRAM_TOKEN=123456:ABC...     # and _CHAT_ID
KUBITOR_NOTIFY_NTFY_SERVER=https://ntfy.sh      # and _TOPIC, optionally _TOKEN
KUBITOR_NOTIFY_GOTIFY_SERVER=https://gotify...  # and _TOKEN
KUBITOR_NOTIFY_SMTP_URL=smtps://user:pass@smtp.example.com:465  # and _FROM, _TO
KUBITOR_NOTIFY_WEBHOOK_URL=https://example.com/hook   # the raw alert, as JSON
KUBITOR_NOTIFY_MIN_SEVERITY=warning             # or critical
KUBITOR_PUBLIC_URL=https://kubitor.example.com  # so messages can link back
```

Set as many as you like; each gets every alert that clears the severity floor.
ntfy and Gotify are self-hostable, so push does not have to mean a vendor. Email
puts the whole alert in the subject line, because a phone's lock screen shows
the subject and nothing else.

Set none of them and alerts are still recorded and still on screen; they simply
go nowhere. Delivery is queued and retried with backoff, so a rate limit or a
restart does not lose a message, and what could not be delivered is shown on the
Alerts screen rather than dropped in silence.

The Telegram chat id is not discoverable from the token: message the bot once,
then read `https://api.telegram.org/bot<token>/getUpdates`.

### When kubitor itself is the thing that stopped

A server cannot report its own death, so two other things do.

**The agents.** One runs on every node and talks to the server every second,
which makes each of them the only process that knows when the server has gone
quiet. Give them somewhere to shout and they will:

```bash
KUBITOR_AGENT_WITNESS_URL=https://hooks.example.com/kubitor-down
KUBITOR_AGENT_WITNESS_AFTER_MS=300000     # five minutes, on purpose
```

Four nodes will send four messages, and **that is the design rather than a
flaw**. Deduplicating needs shared state, the shared state is the server's
database, and the server is what just became unreachable. Each message names
the node that observed it, which makes the duplication informative: one node
reporting means that node's network, and every node reporting means the server.

Give this a narrow address — one that accepts this one shape of message —
rather than the operator's Discord webhook. It goes on every machine.

**A dead-man's switch**, for the case neither kubitor nor its agents survive:
the site losing power, or its uplink.

```bash
KUBITOR_HEARTBEAT_URL=https://hc-ping.com/<uuid>
```

kubitor pings while it is alive and healthchecks.io, Uptime Kuma or cron-job.org
raises the alarm when the pings stop. It is one request on a timer, deliberately:
the outage it covers is total, and there is nothing cleverer to do about it from
inside.

## Backups

kubitor keeps accounts, agent credentials, integration settings and every
reading in one database. Point it at an S3-compatible bucket and it copies that
database there on a schedule — and then **reads it back to check it**, because a
backup nobody has restored is not a backup.

```bash
KUBITOR_BACKUP_S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com
KUBITOR_BACKUP_S3_BUCKET=my-kubitor-backups
KUBITOR_BACKUP_S3_ACCESS_KEY=...
KUBITOR_BACKUP_S3_SECRET_KEY=...
KUBITOR_BACKUP_AGE_RECIPIENT=age1...        # optional, and recommended
KUBITOR_BACKUP_SCHEDULE="17 3 * * *"        # the default
```

Any S3-compatible store works — AWS, MinIO, Backblaze B2, Cloudflare R2, Ceph
RGW. Prefer one the cluster does not depend on: a backup kept on storage served
by the cluster it backs up survives none of the events backups exist for.

**Encryption is a public key, and only a public key.** Give kubitor an age
recipient and it writes backups **it cannot itself read** — a compromised server,
or a leaked bucket, yields ciphertext. The identity stays where you keep keys.
(If you would rather kubitor verified each upload by opening it, set
`KUBITOR_BACKUP_AGE_IDENTITY` too and accept that it can then read its own
history. The Backups screen says which is in force.)

**Retention belongs to the bucket.** Expiring old objects is a lifecycle rule,
which every provider has and none of them get wrong:

```json
{ "Rules": [{ "ID": "kubitor", "Status": "Enabled",
  "Filter": { "Prefix": "" }, "Expiration": { "Days": 90 } }] }
```

Running PostgreSQL instead? kubitor does not back that up. Use your database's
own backup rather than a second, worse one here — the Backups screen says so
rather than looking configured.

### Restoring

```bash
# 1. Stop the server, so nothing writes while you swap the file underneath it.
kubectl -n kubitor scale deploy/kubitor-server --replicas=0

# 2. Fetch the object and decrypt it with the identity you kept.
aws s3 cp s3://my-kubitor-backups/kubitor-20260906T031700Z.db.age .
age --decrypt -i ~/keys/kubitor.age -o kubitor.db kubitor-20260906T031700Z.db.age

# 3. Check it before you trust it, and check what schema it holds.
sqlite3 kubitor.db 'PRAGMA integrity_check;'
sqlite3 kubitor.db 'SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 1;'

# 4. Put it in place of the live file and start the server.
kubectl -n kubitor cp kubitor.db <pod>:/var/lib/kubitor/kubitor.db
kubectl -n kubitor scale deploy/kubitor-server --replicas=1
```

Step 3 matters: if the migration in the backup is **newer** than the image you
are restoring into, roll the image forward first. A restore discovered halfway
through a migration is the worst version of this.

## SSH sessions

**Off in every agent until you turn it on.** This is a feature people are
subject to, so the switch is on the machine being watched rather than on the
dashboard watching it, and the Sessions screen does not appear until something
is actually reporting.

```bash
KUBITOR_AGENT_SESSIONS=access                # or `full`; `off` is the default
KUBITOR_AGENT_AUTH_LOG=/var/log/auth.log     # /var/log/secure on RHEL
```

**Who is logged in** is read from `/proc`: sshd writes the session into its own
process title, and that, the login uid and the start time are all world-readable
— so the agent reads them as `nobody` with every capability dropped. It needs to
see the host's processes, which means `hostPID: true` on the DaemonSet and
nothing more. That is a real privilege and not the default; add it deliberately.

**Who tried** is read from sshd's log, because sshd offers no other way to know:
there is no socket, no file and no API that reports authentication attempts.
The agent's image has no `journalctl` and cannot get one, so a machine that logs
only to journald has no attempts to read from inside a pod — run the agent as a
systemd unit there, or point `KUBITOR_AGENT_AUTH_LOG` at a plain-text log.

`invalid user` is kept separate from a wrong password on purpose. Somebody
guessing at account names and somebody mistyping their own password are
different events, and an operator reads them differently.

**"Cannot read" is an answer, not an empty list.** `hidepid` on `/proc`, a pod
without `hostPID`, and a missing auth log each produce nothing for reasons that
have nothing to do with who is logged in, and each says so rather than showing a
reassuring blank.

## Who can do what

Every account used to be equal, which was fine while kubitor only read a
cluster and stopped being fine the moment there were screens that mint agent
credentials and hold a bucket's keys.

| | admin | operator | viewer |
|---|---|---|---|
| Every cluster screen, and every export | yes | yes | yes |
| Alerts | yes | yes | yes |
| Turning integrations on and off | yes | yes | — |
| Agent credentials | yes | — | — |
| Backups and their bucket | yes | — | — |
| Accounts and roles | yes | — | — |

The line that matters is between running the cluster and holding the
credentials that would let somebody read the estate from outside it. An
operator is trusted with the first.

Existing accounts become `admin` on upgrade, so nothing changes until you
narrow somebody deliberately. New accounts default to `viewer`: one created by
accident should be able to do the least.

**The menu is a courtesy; the routes are the control.** kubitor leaves out what
your role cannot open, and every one of those routes checks again for itself —
a URL and a session cookie get a `403`, whatever the menu showed. Demoting the
last account that can manage accounts is refused, because an install where
nobody can do that cannot be recovered from the dashboard at all.

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

## Copyright and licence

kubitor is written and owned by **ruma** ([@ridanit-ruma](https://github.com/ridanit-ruma)).
Copyright © 2026 ruma. All rights reserved except as granted by the licence below.

Licensed under the **GNU Affero General Public License, version 3** — see
[LICENSE](LICENSE).

The AGPL is deliberate. kubitor is a dashboard people reach over a network, and
that is exactly the case an ordinary GPL does not cover: someone could run a
modified kubitor as a service for others and never publish a line of it. Under
the AGPL, **running a modified version for other people over a network obliges
you to offer them its source**. Using it unmodified obliges you to nothing, and
watching your own cluster with it is not "for other people".

Contributions are welcome under the same licence.
