/**
 * Typed API client. One function per server endpoint, returning the shared
 * response types. All calls hit `/api/*` (the Vite dev server proxies these to
 * the Fastify backend on :4317; in prod Fastify serves both).
 */

import type {
  AnalyticsGroupBy,
  AnalyticsResponse,
  ContinueResponse,
  HealthResponse,
  MemoryResponse,
  ProjectMemoryResponse,
  ProjectsResponse,
  ReindexResponse,
  SearchResponse,
  SearchScope,
  SearchType,
  SessionDetailResponse,
  SessionSort,
  SessionsResponse,
  SourcesResponse,
} from '@claudescope/shared';

/** Thrown when an `/api/*` response is not 2xx. Carries the HTTP status. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, statusText: string, body: string) {
    super(`API ${status} ${statusText}: ${body.slice(0, 200)}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Build a query string from a record, skipping null/undefined/empty values. */
function qs(params: Record<string, string | number | undefined | null>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    usp.set(key, String(value));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/**
 * Core fetch wrapper: prefixes `/api`, parses JSON, and raises {@link ApiError}
 * on non-2xx. `signal` lets callers cancel in-flight requests (e.g. on unmount
 * or rapid search typing).
 */
async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const hasBody = init?.body !== undefined;
  if (hasBody) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: hasBody ? JSON.stringify(init?.body) : undefined,
    signal: init?.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, res.statusText, text);
  }

  return (await res.json()) as T;
}

export interface ListSessionsParams {
  project?: string;
  sort?: SessionSort;
  q?: string;
  agent?: string;
}

export interface SearchParams {
  q: string;
  project?: string;
  type?: SearchType;
  scope?: SearchScope;
}

export interface AnalyticsParams {
  groupBy: AnalyticsGroupBy;
  from?: string;
  to?: string;
}

export const api = {
  /** GET /api/health */
  health(signal?: AbortSignal): Promise<HealthResponse> {
    return request<HealthResponse>('/health', { signal });
  },

  /** GET /api/projects */
  listProjects(signal?: AbortSignal): Promise<ProjectsResponse> {
    return request<ProjectsResponse>('/projects', { signal });
  },

  /** GET /api/sessions?project=&sort=&q=&agent= */
  listSessions(params: ListSessionsParams = {}, signal?: AbortSignal): Promise<SessionsResponse> {
    return request<SessionsResponse>(
      `/sessions${qs({
        project: params.project,
        sort: params.sort,
        q: params.q,
        agent: params.agent,
      })}`,
      { signal },
    );
  },

  /** GET /api/sessions/:id */
  getSession(id: string, signal?: AbortSignal): Promise<SessionDetailResponse> {
    return request<SessionDetailResponse>(`/sessions/${encodeURIComponent(id)}`, { signal });
  },

  /** POST /api/sessions/:id/continue — open the session in the agent's CLI (macOS). */
  continueSession(
    id: string,
    mode: 'resume' | 'fork',
    signal?: AbortSignal,
  ): Promise<ContinueResponse> {
    return request<ContinueResponse>(`/sessions/${encodeURIComponent(id)}/continue`, {
      method: 'POST',
      body: { mode },
      signal,
    });
  },

  /** GET /api/search?q=&project=&type= */
  search(params: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
    return request<SearchResponse>(
      `/search${qs({ q: params.q, project: params.project, type: params.type, scope: params.scope })}`,
      { signal },
    );
  },

  /** GET /api/analytics?groupBy=&from=&to= */
  analytics(params: AnalyticsParams, signal?: AbortSignal): Promise<AnalyticsResponse> {
    return request<AnalyticsResponse>(
      `/analytics${qs({ groupBy: params.groupBy, from: params.from, to: params.to })}`,
      { signal },
    );
  },

  /** GET /api/sources */
  sources(signal?: AbortSignal): Promise<SourcesResponse> {
    return request<SourcesResponse>('/sources', { signal });
  },

  /** GET /api/memory */
  memory(signal?: AbortSignal): Promise<MemoryResponse> {
    return request<MemoryResponse>('/memory', { signal });
  },

  /** GET /api/projects/:id/memory */
  projectMemory(projectId: string, signal?: AbortSignal): Promise<ProjectMemoryResponse> {
    return request<ProjectMemoryResponse>(
      `/projects/${encodeURIComponent(projectId)}/memory`,
      { signal },
    );
  },

  /** POST /api/reindex */
  reindex(signal?: AbortSignal): Promise<ReindexResponse> {
    return request<ReindexResponse>('/reindex', { method: 'POST', body: {}, signal });
  },
};
