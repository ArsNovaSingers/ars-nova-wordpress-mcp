/**
 * Ops tools — install / update / activate / deactivate / delete WordPress
 * plugins by command.
 *
 * These call the companion WP plugin "Ars Nova Ops (Plugin Installer)", which
 * exposes admin-only REST routes under /wp-json/ans-ops/v1/*. That plugin wraps
 * WordPress core's own Plugin_Upgrader, so installs/updates behave exactly like
 * the wp-admin "Upload Plugin" screen.
 *
 * Source of a plugin (pick ONE):
 *   - slug     : a plugin from the WordPress.org directory (public plugins only)
 *   - url      : a zip URL on an allow-listed host (the site itself, github.com +
 *                *.githubusercontent.com, drive.google.com, docs.google.com, ...)
 *   - zip_b64  : a base64-encoded plugin zip
 *   - drive_file_id : a Google Drive file id, fetched server-side and AUTHENTICATED
 *                via ars-nova-google-connector's service account. This is how paid
 *                third-party plugin zips are installed; the Drive folder stays
 *                private (a Drive SHARE LINK does not work as a `url` — Drive
 *                serves servers differently than browsers).
 *
 * zip_path was REMOVED in this revision. It called readFileSync() on the machine
 * running this server. That was Jonathan's PC when the connector ran locally; it
 * has been a Cloud Run container since, where his paths do not exist. It could
 * therefore never succeed, and it failed as a bare ENOENT on a path he could see
 * in Explorer. Use drive_file_id (vendor zips) or url (our own GitHub releases).
 *
 * Requires the companion plugin to be active on the target site. A 404 means it
 * isn't installed/active yet.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

const OPS_NS = "ans-ops/v1";
function ops(path: string): string {
  return `${OPS_NS}/${path.replace(/^\/+/, "")}`;
}

// Installs can download + unzip; give them more room than the default 30s.
const INSTALL_TIMEOUT_MS = 120_000;

/**
 * Resolve the four source options into a request body with exactly one source.
 */
function buildSourceBody(params: Record<string, unknown>): Record<string, unknown> {
  const slug = typeof params.slug === "string" ? params.slug.trim() : "";
  const url = typeof params.url === "string" ? params.url.trim() : "";
  const zip_b64 = typeof params.zip_b64 === "string" ? params.zip_b64 : "";
  const drive_file_id = typeof params.drive_file_id === "string" ? params.drive_file_id.trim() : "";

  const provided = [slug, url, zip_b64, drive_file_id].filter((v) => v !== "").length;
  if (provided !== 1) {
    throw new Error("Provide exactly one source: slug, url, zip_b64, or drive_file_id.");
  }

  const body: Record<string, unknown> = {};
  if (slug) body.slug = slug;
  else if (url) body.url = url;
  else if (zip_b64) body.zip_b64 = zip_b64;
  else body.drive_file_id = drive_file_id;

  if (params.activate !== undefined) body.activate = params.activate;
  if (params.overwrite !== undefined) body.overwrite = params.overwrite;
  if (params.confirm_production !== undefined) body.confirm_production = params.confirm_production;
  return body;
}

const SOURCE_SCHEMA = {
  slug: z.string().optional().describe("Install from the WordPress.org directory by slug (public plugins only)."),
  url: z.string().optional().describe("Zip URL on an allow-listed host (site itself, github.com/*.githubusercontent.com, drive.google.com, docs.google.com)."),
  zip_b64: z.string().optional().describe("Base64-encoded plugin zip."),
  drive_file_id: z.string().optional().describe("Google Drive file id of a plugin zip. Fetched server-side with the site's own service account, so the Drive folder stays private. This is the route for paid third-party plugin zips (Website Admin > _Installers). A Drive share link passed as `url` does NOT work."),
};

export function registerOpsTools(server: McpServer): void {

  // ─── wp_ops_status ─────────────────────────────────────────────────
  server.registerTool(
    "wp_ops_status",
    {
      title: "Ops / Installer Status",
      description: `Check that the Ars Nova Ops (Plugin Installer) plugin is active on the target
site. Returns whether this is the production site, whether file modifications
are allowed (DISALLOW_FILE_MODS), the current user's install capability, and
the allow-listed zip hosts. Call before installing/updating plugins.`,
      inputSchema: { response_format: ResponseFormatField },
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const r = await makeApiRequest<Record<string, unknown>>(ops("status"));
        return toolResult(JSON.stringify(r.data, null, 2), r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wp_install_plugin ─────────────────────────────────────────────
  server.registerTool(
    "wp_install_plugin",
    {
      title: "Install Plugin",
      description: `Install a plugin on the target WordPress site. Pick ONE source: slug (from
WordPress.org), url (allow-listed zip, e.g. one of our GitHub release assets),
zip_b64, or drive_file_id (a vendor zip in the private _Installers Drive folder).
Set activate=true to activate right after install. For updating an
already-installed plugin, use wp_update_plugin instead (or pass overwrite=true
here). On the LIVE production site this refuses unless confirm_production=true.

Requires ars-nova-ops v1.2.1 or later on the target site: before that release an
install over an ALREADY-INSTALLED wordpress.org plugin always failed with a bare
HTTP 500, because the overwrite flag was discarded for slug sources.`,
      inputSchema: {
        ...SOURCE_SCHEMA,
        activate: z.boolean().optional().describe("Activate the plugin immediately after install."),
        overwrite: z.boolean().optional().describe("Overwrite existing files if the plugin is already installed."),
        confirm_production: z.boolean().optional().describe("Required (true) to run on the LIVE production site."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (params: Record<string, unknown>) => {
      try {
        const body = buildSourceBody(params);
        const r = await makeApiRequest<Record<string, unknown>>(ops("plugin/install"), "POST", undefined, body, INSTALL_TIMEOUT_MS);
        return toolResult(`# Plugin install\n\n${JSON.stringify(r.data, null, 2)}`, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wp_update_plugin ──────────────────────────────────────────────
  server.registerTool(
    "wp_update_plugin",
    {
      title: "Update Plugin",
      description: `Update / replace an already-installed plugin in place (overwrite forced on).
Pick ONE source: slug, url, zip_b64, or drive_file_id. Keeps the plugin's
activation state. On the LIVE production site this refuses unless
confirm_production=true.`,
      inputSchema: {
        ...SOURCE_SCHEMA,
        activate: z.boolean().optional().describe("Ensure the plugin is active after updating."),
        confirm_production: z.boolean().optional().describe("Required (true) to run on the LIVE production site."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (params: Record<string, unknown>) => {
      try {
        const body = buildSourceBody(params);
        const r = await makeApiRequest<Record<string, unknown>>(ops("plugin/update"), "POST", undefined, body, INSTALL_TIMEOUT_MS);
        return toolResult(`# Plugin update\n\n${JSON.stringify(r.data, null, 2)}`, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wp_set_plugin_status ──────────────────────────────────────────
  server.registerTool(
    "wp_set_plugin_status",
    {
      title: "Activate / Deactivate Plugin",
      description: `Activate or deactivate an installed plugin. 'plugin' is the plugin basename
(folder/file.php), e.g. 'ars-nova-site-notes/ars-nova-site-notes.php' — the
value shown as "plugin" by wp_list_plugins.`,
      inputSchema: {
        plugin: z.string().describe("Plugin basename, e.g. 'folder/file.php'."),
        active: z.boolean().describe("true = activate, false = deactivate."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (params: { plugin: string; active: boolean }) => {
      try {
        const body = { plugin: params.plugin, active: params.active };
        const r = await makeApiRequest<Record<string, unknown>>(ops("plugin/status"), "POST", undefined, body);
        return toolResult(JSON.stringify(r.data, null, 2), r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wp_delete_plugin ──────────────────────────────────────────────
  server.registerTool(
    "wp_delete_plugin",
    {
      title: "Delete Plugin",
      description: `Deactivate (if needed) and permanently delete an installed plugin from the
site. 'plugin' is the basename (folder/file.php). On the LIVE production site
this refuses unless confirm_production=true. This cannot be undone.`,
      inputSchema: {
        plugin: z.string().describe("Plugin basename, e.g. 'folder/file.php'."),
        confirm_production: z.boolean().optional().describe("Required (true) to run on the LIVE production site."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (params: Record<string, unknown>) => {
      try {
        const body: Record<string, unknown> = { plugin: params.plugin };
        if (params.confirm_production !== undefined) body.confirm_production = params.confirm_production;
        const r = await makeApiRequest<Record<string, unknown>>(ops("plugin/delete"), "POST", undefined, body);
        return toolResult(JSON.stringify(r.data, null, 2), r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

} // end registerOpsTools
