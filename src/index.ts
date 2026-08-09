#!/usr/bin/env node
/**
 * ars-nova-wordpress-mcp — stdio entry point (Claude Desktop).
 *
 * Required env vars (set in claude_desktop_config.json):
 *   WP_SITE_URL      — e.g. https://arsnovasingers.org
 *   WP_USERNAME      — your WordPress admin username
 *   WP_APP_PASSWORD  — 24-char Application Password from wp-admin > Users > Profile
 *
 * Transport: stdio. Logging goes to stderr; never stdout (which would break the
 * MCP protocol on stdin/stdout).
 *
 * Tool registration lives in server.ts, shared with the HTTP entry point
 * (http.ts) so the two transports expose an identical tool set.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { createServer, validateEnvOrExit } from "./server.js";

async function main(): Promise<void> {
  validateEnvOrExit();

  const server = createServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[${SERVER_NAME}] v${SERVER_VERSION} running via stdio`);
}

main().catch((error: unknown) => {
  console.error(`[${SERVER_NAME}] Fatal error:`, error);
  process.exit(1);
});
