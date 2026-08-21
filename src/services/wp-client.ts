/**
 * WordPress REST API client.
 *
 * - Reads WP_SITE_URL, WP_USERNAME, WP_APP_PASSWORD from env on first call.
 * - Builds an authenticated axios instance using HTTP Basic Auth (the WordPress
 *   Application Passwords mechanism, built into WP 5.6+).
 * - Provides a generic makeApiRequest<T>() wrapper plus a WP-aware error
 *   handler that returns actionable messages to the MCP client.
 * - Surfaces WP's pagination headers (X-WP-Total, X-WP-TotalPages) as part of
 *   the response so list tools can build pagination envelopes.
 */
import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";
import { DEFAULT_TIMEOUT_MS, WP_REST_NAMESPACE } from "../constants.js";

let cachedClient: AxiosInstance | null = null;
let cachedSiteUrl: string | null = null;

/**
 * Read and validate required environment variables. Throws on first failure
 * with a message that tells the user exactly which var is missing.
 */
function readEnvConfig(): {
  siteUrl: string;
  username: string;
  appPassword: string;
} {
  const siteUrl = process.env.WP_SITE_URL?.trim();
  const username = process.env.WP_USERNAME?.trim();
  const appPassword = process.env.WP_APP_PASSWORD?.trim();

  if (!siteUrl) {
    throw new Error(
      "Missing WP_SITE_URL environment variable. Add it to claude_desktop_config.json " +
      "under the ars-nova-wordpress server's 'env' block (e.g. https://arsnovasingers.org)."
    );
  }
  if (!username) {
    throw new Error(
      "Missing WP_USERNAME environment variable. Add it to claude_desktop_config.json. " +
      "This is your WordPress admin login username (not display name)."
    );
  }
  if (!appPassword) {
    throw new Error(
      "Missing WP_APP_PASSWORD environment variable. Generate one at " +
      "wp-admin > Users > Profile > Application Passwords, then add it to claude_desktop_config.json."
    );
  }
  // Strip trailing slash from site URL so we can join cleanly.
  return {
    siteUrl: siteUrl.replace(/\/+$/, ""),
    username,
    appPassword,
  };
}

/** Lazy singleton: build the axios client on first use. */
export function getWpClient(): AxiosInstance {
  if (cachedClient) return cachedClient;

  const { siteUrl, username, appPassword } = readEnvConfig();
  cachedSiteUrl = siteUrl;

  cachedClient = axios.create({
    baseURL: `${siteUrl}/wp-json`,
    timeout: DEFAULT_TIMEOUT_MS,
    headers: {
      Accept: "application/json",
    },
    auth: {
      username,
      password: appPassword,
    },
    // Don't throw for 4xx/5xx — let our handler decide.
    validateStatus: () => true,
  });

  return cachedClient;
}

/** Returns the configured site URL (without trailing slash). Throws if env not set. */
export function getSiteUrl(): string {
  if (!cachedSiteUrl) {
    readEnvConfig(); // populates cachedSiteUrl as a side effect via getWpClient
    getWpClient();
  }
  return cachedSiteUrl as string;
}

/**
 * Wrapped result of a WP REST call — exposes both the parsed body and the
 * pagination headers so list tools can build proper envelopes without
 * each one re-parsing axios responses.
 */
export interface WpApiResult<T> {
  data: T;
  total: number;        // From X-WP-Total header (0 if absent)
  totalPages: number;   // From X-WP-TotalPages header (0 if absent)
  status: number;
}

/**
 * Make an authenticated WP REST call. Throws a clear error on auth failures or
 * unexpected non-2xx; otherwise returns the parsed body + pagination metadata.
 *
 * @param endpoint  Path under /wp-json (without leading slash). Use "" for root, or
 *                  "wp/v2/posts", or pass a fully-qualified path like
 *                  "wp/v2/posts" + querystring via params.
 * @param method    HTTP verb. Defaults to GET.
 * @param params    Querystring params.
 * @param data      Body for POST/PUT.
 */
export async function makeApiRequest<T>(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  params?: Record<string, unknown>,
  data?: unknown,
  timeoutMs?: number
): Promise<WpApiResult<T>> {
  const client = getWpClient();
  const config: AxiosRequestConfig = {
    method,
    url: `/${endpoint.replace(/^\/+/, "")}`,
    params,
    data,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  };

  let response: AxiosResponse<T>;
  try {
    response = await client.request<T>(config);
  } catch (error) {
    // Network / timeout errors hit here (validateStatus prevents status-based throws).
    throw mapNetworkError(error);
  }

  if (response.status >= 400) {
    throw mapHttpError(response);
  }

  const totalHeader = response.headers["x-wp-total"];
  const totalPagesHeader = response.headers["x-wp-totalpages"];

  return {
    data: response.data,
    total: totalHeader ? parseInt(String(totalHeader), 10) : 0,
    totalPages: totalPagesHeader ? parseInt(String(totalPagesHeader), 10) : 0,
    status: response.status,
  };
}

/**
 * Convenience wrapper that catches ANY error from makeApiRequest and returns
 * a string suitable to embed in a tool's text response. Use in tool handlers
 * where we want to surface failures rather than reject.
 */
export function handleApiError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return `Unexpected error: ${String(error)}`;
}

// -----------------------------------------------------------------------------
// Internal error mappers
// -----------------------------------------------------------------------------

function mapHttpError(response: AxiosResponse<unknown>): Error {
  const status = response.status;
  const body = response.data as Record<string, unknown> | undefined;
  const wpCode = typeof body?.code === "string" ? body.code : undefined;

  // A WP_Error serialises as { code, message }. Our own plugins (ars-nova-ops,
  // ars-nova-media) answer a failed write with a WP_REST_Response carrying
  // { ok:false, error, messages } instead, which matches NEITHER field - so
  // every one of those failures used to arrive here as a bare "HTTP 500" while
  // the server had already named the cause. Six plugin installs were once
  // diagnosed blind because of exactly this. Read both shapes.
  const wpMessage =
    typeof body?.message === "string" ? body.message :
    typeof body?.error === "string" ? body.error :
    undefined;

  // ars-nova-ops returns the WP_Upgrader step log in `messages`. It is the part
  // that says WHICH step failed ("Downloading...", "Unpacking...", "Destination
  // folder already exists"), so it is worth more than the summary line.
  const wpDetail = Array.isArray(body?.messages) && body.messages.length
    ? " Detail: " + body.messages
        .map((m) => String(m).replace(/&#8230;/g, "...").replace(/<[^>]+>/g, ""))
        .join(" | ")
    : "";

  switch (status) {
    case 401:
      return new Error(
        "WordPress rejected the credentials (HTTP 401). Verify WP_USERNAME matches " +
        "your WP login and that WP_APP_PASSWORD is the 24-character Application " +
        "Password (not your normal account password). Regenerate one at " +
        "wp-admin > Users > Profile > Application Passwords if needed."
      );
    case 403:
      return new Error(
        `Permission denied (HTTP 403). Your WP user lacks the capability for this ` +
        `endpoint. ${wpCode ? `WP error: ${wpCode}` : ""}${wpMessage ? ` — ${wpMessage}` : ""}${wpDetail}`
      );
    case 404:
      return new Error(
        `Endpoint or resource not found (HTTP 404). ${wpCode ? `WP error: ${wpCode}` : ""}` +
        `${wpMessage ? ` — ${wpMessage}` : ""} If this is for a plugin/theme endpoint, ` +
        `confirm the plugin is active and exposes a REST endpoint.`
      );
    case 429:
      return new Error("Rate limited (HTTP 429). Wait a moment and try again.");
    default:
      return new Error(
        `WordPress API returned HTTP ${status}.${wpCode ? ` Code: ${wpCode}` : ""}` +
        `${wpMessage ? ` Message: ${wpMessage}` : ""}${wpDetail}`
      );
  }
}

function mapNetworkError(error: unknown): Error {
  if (axios.isAxiosError(error)) {
    if (error.code === "ECONNABORTED") {
      return new Error(`Request timed out after ${DEFAULT_TIMEOUT_MS}ms. The site may be slow or unreachable.`);
    }
    if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") {
      return new Error(`Cannot resolve WP_SITE_URL. Check the URL is correct and reachable: ${error.message}`);
    }
    if (error.code === "ECONNREFUSED") {
      return new Error(`Connection refused by WP_SITE_URL host. Site may be down or blocking the request.`);
    }
    return new Error(`Network error talking to WordPress: ${error.message}`);
  }
  return new Error(`Unexpected error talking to WordPress: ${error instanceof Error ? error.message : String(error)}`);
}

// -----------------------------------------------------------------------------
// URL helpers — exported so tool modules don't hardcode wp/v2 strings
// -----------------------------------------------------------------------------

/** Build a WP REST endpoint path under the core wp/v2 namespace. */
export function wpV2(path: string): string {
  return `${WP_REST_NAMESPACE}/${path.replace(/^\/+/, "")}`;
}
