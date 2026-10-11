import { type Fetch, UpstreamError, parseJson, readBoundedText, requestJson } from "../http.ts";
import { type AuthFile, isRecord, parseApiCallResponse, parseAuthFiles } from "../parse.ts";

/** CLIProxyAPI management client. It holds the management key; upstream OAuth tokens never leave CLIProxyAPI. */
export class CliProxy {
  constructor(
    private readonly baseUrl: string,
    private readonly managementKey: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/v0/management/${path}`;
  }

  async authFiles(): Promise<AuthFile[]> {
    const payload = await requestJson(this.fetchImpl, this.url("auth-files"), {
      headers: { Authorization: `Bearer ${this.managementKey}`, Accept: "application/json" },
    });
    const files = parseAuthFiles(payload);
    if (!files) throw new UpstreamError("malformed auth-files response");
    return files;
  }

  /** GET `url` as the credential `authIndex`; `$TOKEN$` in headers is replaced by CLIProxyAPI. */
  async get(authIndex: string, url: string, header: Record<string, string>): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url("api-call"), {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${this.managementKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ auth_index: authIndex, method: "GET", url, header }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new UpstreamError("cliproxy unreachable");
    }
    const payload = parseJson(await readBoundedText(response));
    if (!response.ok) {
      const reason = isRecord(payload) && typeof payload.error === "string" ? payload.error.slice(0, 120) : "";
      throw new UpstreamError(`cliproxy HTTP ${response.status}${reason ? `: ${reason}` : ""}`, response.status);
    }
    const result = parseApiCallResponse(payload);
    if (!result) throw new UpstreamError("malformed api-call response");
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new UpstreamError(`HTTP ${result.statusCode}`, result.statusCode, result.body.slice(0, 2000));
    }
    return parseJson(result.body);
  }
}
