import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import type { HostIngest } from '../collect/host-ingest.js';
import type { AgentTokensRepo } from '../db/agent-tokens.repo.js';
import type { ServiceAccountVerifier } from '../kube/sa-token.js';
import type { IngestPipeline, IngestReport } from '../plugins/ingest.js';
import { AGENT_TOKENS, HOST_INGEST, INGEST_PIPELINE, SA_VERIFIER } from '../tokens.js';

/** Facets an agent is allowed to write. Nothing else is reachable by a token. */
const AGENT_FACETS: Record<string, string> = {
  hardware: 'host.hardware',
};

const body = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).max(1000),
});

@Controller('api/ingest')
export class IngestController {
  readonly #pipeline: IngestPipeline;
  readonly #tokens: AgentTokensRepo;
  readonly #host: HostIngest;
  readonly #verifier: ServiceAccountVerifier | null;

  constructor(
    @Inject(INGEST_PIPELINE) pipeline: IngestPipeline,
    @Inject(AGENT_TOKENS) tokens: AgentTokensRepo,
    @Inject(HOST_INGEST) host: HostIngest,
    @Optional() @Inject(SA_VERIFIER) verifier: ServiceAccountVerifier | null,
  ) {
    this.#pipeline = pipeline;
    this.#tokens = tokens;
    this.#host = host;
    this.#verifier = verifier ?? null;
  }

  /**
   * The agent's once-a-second host report.
   *
   * Separate from the facet endpoint below because it is not a facet write: the
   * live cache takes every reading and the database takes one in fifteen.
   */
  @Post('host')
  @HttpCode(202)
  async host(
    @Headers('authorization') authorization: string | undefined,
    @Body() payload: unknown,
  ): Promise<IngestReport> {
    const node = await this.#identify(authorization);
    const parsed = body.safeParse(payload);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_body' });

    const now = Date.now();
    const accepted = await this.#host.accept(node, parsed.data.rows, now);
    await this.#tokens.touch(node, now);

    return {
      accepted,
      dropped: parsed.data.rows.length - accepted,
      reasons:
        accepted === parsed.data.rows.length
          ? {}
          : { invalid_row: parsed.data.rows.length - accepted },
    };
  }

  /**
   * Always answers 2xx for a batch it could partially use.
   *
   * The agent only advances its buffer on success, so refusing a batch because
   * one row was malformed would wedge that node's stream permanently — and
   * anyone able to reach this endpoint could cause it deliberately.
   */
  @Post(':facet')
  @HttpCode(202)
  async ingest(
    @Param('facet') facetPath: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() payload: unknown,
  ): Promise<IngestReport> {
    const facet = AGENT_FACETS[facetPath];
    if (!facet) throw new BadRequestException({ error: 'unknown_facet' });

    const node = await this.#identify(authorization);

    const parsed = body.safeParse(payload);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_body' });

    const now = Date.now();
    // The credential decides which node the rows belong to. A row claiming
    // another node is rewritten, so one compromised agent cannot forge the fleet.
    const rows = parsed.data.rows.map((row) => ({ ...row, node }));

    const report = await this.#pipeline.ingest('host-agent', facet, rows, now);
    await this.#tokens.touch(node, now);

    return report;
  }

  /**
   * The node this caller is, or a 401.
   *
   * Two credentials are accepted, in order of preference. A projected
   * service-account token is signed by the API server and names the node it was
   * issued on, so nothing had to be distributed and nothing can be replayed as
   * another node. A static token stays for agents outside the cluster, where no
   * such token exists.
   */
  async #identify(authorization: string | undefined): Promise<string> {
    const credential = bearer(authorization);
    if (!credential) throw new UnauthorizedException({ error: 'missing_token' });

    const identity = await this.#verifier?.verify(credential);
    if (identity) return identity.node;

    const node = await this.#tokens.nodeFor(credential);
    if (!node) throw new UnauthorizedException({ error: 'invalid_token' });

    return node;
  }
}

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}
