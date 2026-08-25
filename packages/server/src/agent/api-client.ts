/**
 * Typed client for the daemon's localhost HTTP API.
 *
 * Agent-facing consumers (the MCP server, the CLI query subcommands) never open
 * the DuckDB index themselves — the daemon holds the file read-write and DuckDB
 * allows only one such process — so every read proxies through the running
 * daemon over loopback HTTP.
 */

import type {
  AnalyticsQuery,
  AnalyticsResponse,
  DigestQuery,
  DigestResponse,
  HealthResponse,
  MemoryResponse,
  ProjectMemoryResponse,
  ProjectsResponse,
  SearchQuery,
  SearchResponse,
  SessionDetailQuery,
  SessionDetailResponse,
  SessionMeta,
  SessionsQuery,
} from '@claudescope/shared';

/** Query-param bag: undefined/empty values are omitted from the URL. */
type Params = Record<string, string | number | boolean | undefined>;

export class ApiClient {
  constructor(readonly baseUrl: string) {}

  private async get<T>(path: string, params?: Params): Promise<T> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  health(): Promise<HealthResponse> {
    return this.get('/api/health');
  }

  projects(): Promise<ProjectsResponse> {
    return this.get('/api/projects');
  }

  sessions(q: SessionsQuery = {}): Promise<SessionMeta[]> {
    return this.get('/api/sessions', q as Params);
  }

  session(id: string, q: SessionDetailQuery = {}): Promise<SessionDetailResponse> {
    return this.get(`/api/sessions/${encodeURIComponent(id)}`, q as Params);
  }

  search(q: SearchQuery): Promise<SearchResponse> {
    return this.get('/api/search', q as unknown as Params);
  }

  memory(): Promise<MemoryResponse> {
    return this.get('/api/memory');
  }

  projectMemory(projectId: string): Promise<ProjectMemoryResponse> {
    return this.get(`/api/projects/${encodeURIComponent(projectId)}/memory`);
  }

  analytics(q: AnalyticsQuery): Promise<AnalyticsResponse> {
    return this.get('/api/analytics', q as unknown as Params);
  }

  digest(q: DigestQuery = {}): Promise<DigestResponse> {
    return this.get('/api/analytics/digest', q as unknown as Params);
  }
}
