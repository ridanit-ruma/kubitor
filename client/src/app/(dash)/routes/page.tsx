'use client';

import { useMemo } from 'react';
import { FacetTable } from '@/components/facet-table';
import { type RouteRow, routeColumns, routeKinds } from '@/components/route-columns';
import { useManifest } from '@/lib/manifest-context';
import { encodeRouteId } from '@/lib/route-id';

/**
 * Every address the cluster answers on, whoever publishes it.
 *
 * One screen, not one per ingress. Traefik had a list of its own, and it was
 * the same rows twice: an operator looking for an address had to know which of
 * the two screens their cluster's ingress had put it on. What Traefik actually
 * added — its matcher expression, in its own words — is a column here now, and
 * it appears exactly where Traefik is installed. Another ingress with something
 * of its own to say will deepen this screen the same way rather than starting a
 * second one.
 */
export default function RoutesPage() {
  const { manifest } = useManifest();
  const sources = manifest?.facets['http.routes']?.sources ?? [];

  // Keyed on the sources rather than the manifest object, which is replaced on
  // every poll and would otherwise rebuild the table's columns each time.
  const key = sources.join(',');
  const columns = useMemo(() => routeColumns(key === '' ? [] : key.split(',')), [key]);
  const kinds = useMemo(() => routeKinds(key === '' ? [] : key.split(',')), [key]);

  return (
    <div className="screen gap-3">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Routes</h1>
        <p className="text-sm text-muted-foreground">
          Every address the cluster answers on. Open one to see its definition and the requests it
          has served.
        </p>
      </div>
      <FacetTable<RouteRow>
        facet="routes"
        columns={columns}
        filters={[{ key: 'kind', label: 'Kinds', values: kinds }]}
        searchPlaceholder="Find a route by host, path or service"
        excludable
        excludePlaceholder="Hide routes matching…"
        emptyMessage="Nothing is routed here yet."
        onRowHref={(row) =>
          `/routes/${encodeRouteId({
            kind: row.kind,
            namespace: row.namespace,
            name: row.name,
            host: row.host,
            path: row.path,
          })}`
        }
      />
    </div>
  );
}
