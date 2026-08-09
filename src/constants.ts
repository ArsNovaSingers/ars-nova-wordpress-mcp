/**
 * Shared constants for ars-nova-wordpress-mcp.
 */

/** Maximum size of a single tool response in characters. Beyond this, responses are truncated with guidance. */
export const CHARACTER_LIMIT = 25_000;

/** Default page size when listing resources. */
export const DEFAULT_PAGE_SIZE = 20;

/** Maximum page size accepted from clients (WP REST API hard caps at 100). */
export const MAX_PAGE_SIZE = 100;

/** Default HTTP timeout for WP REST API calls. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** WP REST API namespace for the core endpoints we use. */
export const WP_REST_NAMESPACE = "wp/v2";

/** Server identity reported to MCP clients. */
export const SERVER_NAME = "ars-nova-wordpress-mcp";
export const SERVER_VERSION = "0.2.0";

/** Required environment variables. Validated on startup. */
export const REQUIRED_ENV_VARS = ["WP_SITE_URL", "WP_USERNAME", "WP_APP_PASSWORD"] as const;

/**
 * Optional label for environment identification.
 * Set WP_ENV_LABEL in claude_desktop_config.json env block, e.g.:
 *   "WP_ENV_LABEL": "⚠️ LIVE — arsnovasingers.org"
 *   "WP_ENV_LABEL": "🔧 DEV — arsnovasingers.kinsta.cloud"
 * Returned by wp_check_environment. Call this before any write operation.
 */
export const ENV_LABEL = process.env.WP_ENV_LABEL ?? process.env.WP_SITE_URL ?? "unknown";
