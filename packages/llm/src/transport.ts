// The injectable network seam shared by every adapter.
//
// A `Transport` is a single async function that, given a normalized HTTP request
// description, yields the provider's *raw* streaming chunks (already decoded to
// strings). Both adapter shapes parse those raw chunks into the normalized
// `LLMEvent` union. Tests inject a transport that replays a canned chunk script
// with NO real network; production uses `fetchSseTransport`, which performs a
// real fetch and decodes the Server-Sent-Events (SSE) body line by line.
import { ErrorCode, OrthaError } from "@ortha/contracts";

export interface TransportRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Record<string, string>;
  /** Already-serialized JSON body. */
  readonly body: string;
  readonly signal?: AbortSignal;
}

/**
 * Yields raw stream chunks. For SSE providers each yielded string is the *data*
 * payload of a single `data:` line (the `data:` prefix already stripped, and the
 * terminal `[DONE]` sentinel filtered out). Adapters JSON.parse each chunk.
 */
export type Transport = (req: TransportRequest) => AsyncIterable<string>;

/** Default production transport: real fetch + SSE line decoding. */
export function fetchSseTransport(fetchImpl: typeof fetch = globalThis.fetch): Transport {
  return async function* (req: TransportRequest): AsyncIterable<string> {
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
      body: req.body,
    };
    if (req.signal) init.signal = req.signal;

    let res: Response;
    try {
      res = await fetchImpl(req.url, init);
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      throw new OrthaError(
        aborted ? ErrorCode.TIMEOUT : ErrorCode.PROVIDER_DOWN,
        aborted ? "llm request aborted" : "llm network error",
        { retryable: !aborted, cause: e },
      );
    }

    if (!res.ok) {
      const detail = await safeText(res);
      throw httpError(res.status, detail);
    }
    if (!res.body) {
      throw new OrthaError(ErrorCode.PROVIDER_DOWN, "llm response had no body", { retryable: true });
    }

    yield* decodeSse(res.body, req.signal);
  };
}

/** Decode a ReadableStream of SSE bytes into the data payload of each event. */
export async function* decodeSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line; lines within an event that
      // start with "data:" carry the payload. We coalesce multi-line data.
      let idx: number;
      while ((idx = indexOfEvent(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^(\r?\n)+/, "");
        const data = extractData(rawEvent);
        if (data !== null && data !== "[DONE]") yield data;
      }
    }
    // Flush any trailing event without a terminating blank line.
    const data = extractData(buffer);
    if (data !== null && data !== "[DONE]") yield data;
  } finally {
    reader.releaseLock();
  }
}

function indexOfEvent(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function extractData(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r?\n/);
  const dataParts: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) dataParts.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataParts.length === 0) return null;
  return dataParts.join("\n");
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export function httpError(status: number, detail: string): OrthaError {
  switch (status) {
    case 400:
      return new OrthaError(ErrorCode.BAD_REQUEST, `llm bad request: ${detail}`);
    case 401:
    case 403:
      return new OrthaError(ErrorCode.AUTH, `llm unauthorized: ${detail}`);
    case 402:
      return new OrthaError(ErrorCode.INSUFFICIENT_CREDITS, `llm out of credits: ${detail}`);
    case 404:
      return new OrthaError(ErrorCode.NOT_FOUND, `llm model/endpoint not found: ${detail}`);
    case 429:
      return new OrthaError(ErrorCode.PROVIDER_DOWN, `llm rate limited: ${detail}`, { retryable: true });
    default:
      if (status >= 500) {
        return new OrthaError(ErrorCode.PROVIDER_DOWN, `llm upstream ${status}: ${detail}`, { retryable: true });
      }
      return new OrthaError(ErrorCode.BAD_REQUEST, `llm unexpected ${status}: ${detail}`);
  }
}

export function abortError(): OrthaError {
  return new OrthaError(ErrorCode.TIMEOUT, "llm request aborted", { retryable: false });
}
