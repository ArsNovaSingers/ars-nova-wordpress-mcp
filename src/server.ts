/**
 * Shared server construction, used by BOTH entry points:
 *   - index.ts : stdio, for Claude Desktop (unchanged behaviour)
 *   - http.ts  : Streamable HTTP, for Cloud Run + Claude custom connectors
 *
 * Extracted from index.ts so the two transports can never drift apart in which
 * tools they expose.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { REQUIRED_ENV_VARS, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { registerContentTools } from "./tools/content.js";
import { registerMediaTools } from "./tools/media.js";
import { registerUserTools } from "./tools/users.js";
import { registerTaxonomyTools } from "./tools/taxonomy.js";
import { registerSiteTools } from "./tools/site.js";
import { registerSeoTools } from "./tools/seo.js";
import { registerBulkTools } from "./tools/bulk.js";
import { registerAcfTools } from "./tools/acf.js";
import { registerMenuTools } from "./tools/menus.js";
import { registerSettingsTools } from "./tools/settings.js";
import { registerThemeModsTools } from "./tools/theme-mods.js";
import { registerFooterTools } from "./tools/footer-tools.js";
import { registerRawContentTools } from "./tools/raw-content.js";
import { registerSiteNotesTools } from "./tools/site-notes.js";
import { registerWooCommerceTools } from "./tools/woocommerce.js";
import { registerTickeraTools } from "./tools/tickera.js";
import { registerOpsTools } from "./tools/ops.js";
import { registerRedirectionTools } from "./tools/redirection.js";
import { registerPassthroughTools } from "./tools/passthrough.js";

export function validateEnvOrExit(): void {
  const missing = REQUIRED_ENV_VARS.filter((v) => !process.env[v]?.trim());
  if (missing.length) {
    console.error(
      `[${SERVER_NAME}] Missing required env vars: ${missing.join(", ")}.\n` +
      `Locally: add them under the 'env' block of the ars-nova-wordpress entry in ` +
      `claude_desktop_config.json.\n` +
      `On Cloud Run: supply them via --set-secrets / --set-env-vars.\n` +
      `See README.md for setup instructions.`
    );
    process.exit(1);
  }
}

/**
 * Build a fully-registered McpServer. Called once for stdio, and once per
 * request in the stateless HTTP transport.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registerContentTools(server);
  registerMediaTools(server);
  registerUserTools(server);
  registerTaxonomyTools(server);
  registerSiteTools(server);
  registerSeoTools(server);
  registerBulkTools(server);
  registerAcfTools(server);
  registerMenuTools(server);
  registerSettingsTools(server);
  registerThemeModsTools(server);
  registerFooterTools(server);
  registerRawContentTools(server);
  registerSiteNotesTools(server);
  registerWooCommerceTools(server);
  registerTickeraTools(server);
  registerOpsTools(server);
  registerRedirectionTools(server);
  registerPassthroughTools(server);

  return server;
}
