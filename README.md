# kubitor

An open-source monitoring dashboard for Kubernetes operators who would rather not assemble
Prometheus, Grafana, exporters and dashboards before they can see anything.

`helm install`, open the page, and the screens are already full.

kubitor discovers what your cluster actually runs — Traefik or ingress-nginx or cloudflared,
Cilium or plain networking, Rook or a single local-path PVC — and shows the screens that
match. Bare k3s works out of the box; a richer cluster simply gets more.

Everything you can see, you can export as JSON or CSV with your filters applied.

## Deploying

`deploy/` holds Kubernetes manifests (kustomize). Point Flux, Argo or
`kubectl apply -k` at it, and supply a secret named `kubitor-server` with
`KUBITOR_SESSION_SECRET` (32 characters or more) and, on first install,
`KUBITOR_ADMIN_INITIAL_PASSWORD`.

The server needs read access to the cluster and a volume for its SQLite file;
both are in the manifests.

The agent is optional. Install it to see host RAM, CPU and GPU clocks, mounted
filesystems and temperatures — none of which the Kubernetes API can answer. It
needs no secret of its own: each pod presents a projected service-account token
that names the node it runs on, and the server verifies it against the cluster's
public keys.

## Status

Early development.

## License

MIT
