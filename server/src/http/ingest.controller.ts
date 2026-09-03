import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import type { AgentTokensRepo } from '../db/agent-tokens.repo.js';
import type { IngestPipeline, IngestReport } from '../plugins/ingest.js';
import { AGENT_TOKENS, INGEST_PIPELINE } from '../tokens.js';

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

  constructor(
    @Inject(INGEST_PIPELINE) pipeline: IngestPipeline,
    @Inject(AGENT_TOKENS) tokens: AgentTokensRepo,
  ) {
    this.#pipeline = pipeline;
    this.#tokens = tokens;
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

    const token = bearer(authorization);
    if (!token) throw new UnauthorizedException({ error: 'missing_token' });

    const node = await this.#tokens.nodeFor(token);
    if (!node) throw new UnauthorizedException({ error: 'invalid_token' });

    const parsed = body.safeParse(payload);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_body' });

    const now = Date.now();
    // The token decides which node the rows belong to. A row claiming another
    // node is rewritten, so one compromised agent cannot forge the fleet.
    const rows = parsed.data.rows.map((row) => ({ ...row, node }));

    const report = await this.#pipeline.ingest('host-agent', facet, rows, now);
    await this.#tokens.touch(node, now);

    return report;
  }
}

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}
