export interface ClientOptions {
  baseUrl: string;
  /** A server-side platform key created by the user in Managed Agents. */
  apiKey: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
  /** Enable the unpublished request-identity and cancellation contract after its rollout. */
  durable?: boolean;
}

export interface Session {
  id: string;
  user_id: string;
  status: string;
  agent_id?: string;
  title?: string;
  created_at: string;
  last_active: string;
}

export interface TranscriptMessage {
  seq: number;
  role: string;
  content_json: string;
  created_at: string;
}

export interface TranscriptPage {
  messages: TranscriptMessage[];
  has_more: boolean;
}

export interface ChatEvent {
  event: string;
  data: unknown;
  /** Present only when the durable contract is enabled. */
  clientRequestId?: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
  /** Durable contract only: reuse this identity when reconnecting the same turn. */
  clientRequestId?: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export class StreamError extends Error {
  constructor(readonly data: unknown, readonly clientRequestId?: string) {
    super(typeof data === "object" && data !== null && "message" in data && typeof data.message === "string"
      ? data.message : "Chat stream failed");
    this.name = "StreamError";
  }
}

function parseFrame(frame: string): { event: string; data: unknown } | undefined {
  let event = "message";
  const lines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trimStart();
    if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
  }
  if (lines.length === 0) return undefined;
  const raw = lines.join("\n");
  try { return { event, data: JSON.parse(raw) as unknown }; }
  catch { return { event, data: raw }; }
}

async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      // Leave a trailing CR until the next chunk so CRLF split across reads
      // remains one line ending.
      pending = pending.replace(/\r\n|\r(?=.)/g, "\n");
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = parseFrame(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        if (frame) yield frame;
      }
      if (done) {
        pending = pending.replace(/\r/g, "\n");
        break;
      }
    }
    if (pending.trim()) {
      const frame = parseFrame(pending);
      if (frame) yield frame;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class ManagedAgentsClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.doFetch = options.fetch ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = typeof this.options.apiKey === "function" ? await this.options.apiKey() : this.options.apiKey;
    if (!token) throw new Error("API key is required");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await this.doFetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const raw = await response.text();
      let message = raw || `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(raw) as { error?: unknown };
        if (typeof parsed.error === "string") message = parsed.error;
      } catch { /* Keep the raw response. */ }
      throw new ApiError(response.status, message);
    }
    return response;
  }

  /** Create a conversation with an existing accessible agent template. */
  async createSession(agentId: string): Promise<string> {
    if (!agentId) throw new Error("agentId is required");
    const response = await this.request("/api/sessions", {
      method: "POST", body: JSON.stringify({ agent_id: agentId }),
    });
    const result = await response.json() as { session_id: string };
    return result.session_id;
  }

  /** Rename a session. Names are visible in the platform's session list. */
  async renameSession(sessionId: string, name: string): Promise<void> {
    if (!name.trim()) throw new Error("name is required");
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
      method: "PATCH", body: JSON.stringify({ title: name }),
    });
  }

  async endSession(sessionId: string): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  async listSessions(limit?: number, offset?: number): Promise<{ sessions: Session[]; has_more: boolean }> {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set("limit", String(limit));
    if (offset !== undefined) query.set("offset", String(offset));
    const suffix = query.size ? `?${query}` : "";
    return await (await this.request(`/api/sessions${suffix}`)).json() as { sessions: Session[]; has_more: boolean };
  }

  async getTranscript(sessionId: string, limit?: number, beforeSeq?: number): Promise<TranscriptPage> {
    const query = new URLSearchParams();
    if (limit !== undefined) query.set("limit", String(limit));
    if (beforeSeq !== undefined) query.set("before_seq", String(beforeSeq));
    const suffix = query.size ? `?${query}` : "";
    return await (await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages${suffix}`)).json() as TranscriptPage;
  }

  async cancel(sessionId: string, requestMessageId?: string): Promise<void> {
    if (!this.options.durable) throw new Error("Cancellation requires the durable session API");
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: "POST", body: JSON.stringify({ request_message_id: requestMessageId ?? "" }),
    });
  }

  /** Stream one turn. On the current API, inspect history before retrying a dropped stream. */
  async *chat(sessionId: string, content: string, options: ChatOptions = {}): AsyncGenerator<ChatEvent> {
    if (!content) throw new Error("content is required");
    if (!this.options.durable && options.clientRequestId !== undefined) {
      throw new Error("clientRequestId requires the durable session API");
    }
    const requestId = this.options.durable ? options.clientRequestId ?? `req-${crypto.randomUUID()}` : undefined;
    const response = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: requestId ? { "X-Client-Request-Id": requestId } : undefined,
      body: JSON.stringify({ content }),
      signal: options.signal,
    });
    if (!response.body) throw new Error("Chat response has no body stream");
    const acceptedId = requestId ? response.headers.get("X-Client-Request-Id") || requestId : undefined;
    let completed = false;
    for await (const frame of frames(response.body)) {
      if (frame.event === "error") throw new StreamError(frame.data, acceptedId);
      yield { ...frame, clientRequestId: acceptedId };
      if (frame.event === "done") {
        completed = true;
        break;
      }
    }
    if (!completed) throw new StreamError({ message: "Chat stream ended before done" }, acceptedId);
  }
}
