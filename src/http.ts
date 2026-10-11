export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

export class UpstreamError extends Error {
  /** The start of a non-2xx response body, kept only for classifying the failure; never logged. */
  constructor(message: string, readonly status?: number, readonly body?: string) {
    super(message);
  }
}

export async function readBoundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new UpstreamError("oversized response");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new UpstreamError("oversized response");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError("malformed response");
  }
}

/** Fetch JSON with a timeout and a size cap. Errors carry only the status, never the body or credentials. */
export async function requestJson(fetchImpl: Fetch, url: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new UpstreamError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "request failed");
  }
  const text = await readBoundedText(response);
  if (!response.ok) throw new UpstreamError(`HTTP ${response.status}`, response.status, text.slice(0, 2000));
  return parseJson(text);
}
