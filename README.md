# kubitor

An open-source monitoring dashboard for Kubernetes operators who would rather not assemble
Prometheus, Grafana, exporters and dashboards before they can see anything.

`helm install`, open the page, and the screens are already full.

kubitor discovers what your cluster actually runs — Traefik or ingress-nginx or cloudflared,
Cilium or plain networking, Rook or a single local-path PVC — and shows the screens that
match. Bare k3s works out of the box; a richer cluster simply gets more.

Everything you can see, you can export as JSON or CSV with your filters applied.

## Status

Early development. See `deploy/` for the Helm chart once it lands.

## License

MIT
