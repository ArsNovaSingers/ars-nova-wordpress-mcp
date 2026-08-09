/**
 * Redirection plugin tools — create and list 301/302 redirects.
 *
 * These hit the Redirection plugin's OWN REST namespace (redirection/v1), not
 * core wp/v2, so they require the plugin (redirection/redirection) to be ACTIVE.
 * If it is deactivated the endpoints 404 and the error mapper in
 * services/wp-client.ts will say so.
 *
 * Why this exists: renaming a page slug or re-parenting a page changes its URL.
 * Every old URL then needs a 301 so inbound links and search rankings survive.
 * Without these tools that is manual clicking in wp-admin > Tools > Redirection.
 *
 * AUTH NOTE: Redirection registers its routes behind a manage_options
 * permission callback, which Application Password Basic Auth satisfies. Some
 * builds additionally expect an X-WP-Nonce header. If these tools return 403
 * while core wp/v2 tools work fine, that nonce requirement is the cause and the
 * redirect has to be added in wp-admin instead.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

/** The Redirection plugin's REST namespace, relative to /wp-json. */
const REDIRECTION_NS = "redirection/v1";

interface RawRedirect {
  id: number;
  url: string;
  match_url?: string;
  action_type?: string;
  action_code?: number;
  action_data?: { url?: string } | string;
  title?: string;
  enabled?: boolean;
  group_id?: number;
  hits?: number;
}

interface RawRedirectList {
  items?: RawRedirect[];
  total?: number;
}

// -----------------------------------------------------------------------------
// Input schemas
// -----------------------------------------------------------------------------

const ListRedirectsSchema = z.object({
  search: z.string().optional().describe("Optional keyword to filter source/target URLs."),
  per_page: z.number().int().min(1).max(200).default(50).describe("Page size (1-200). Default 50."),
  page: z.number().int().min(1).default(1).describe("1-based page number."),
  response_format: ResponseFormatField,
}).strict();
type ListRedirectsInput = z.infer<typeof ListRedirectsSchema>;

const CreateRedirectSchema = z.object({
  source: z.string().describe("Old path to redirect FROM. Root-relative with a leading slash, e.g. '/listen/current-season/'."),
  target: z.string().describe("Path or full URL to redirect TO, e.g. '/concerts/this-season/'."),
  code: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).default(301)
    .describe("HTTP status. 301 = permanent (default; passes SEO authority). 302/307 = temporary."),
  title: z.string().optional().describe("Optional note shown in the Redirection admin list."),
  group_id: z.number().int().default(1).describe("Redirection group ID. 1 = the default 'Redirections' group."),
  regex: z.boolean().default(false).describe("Treat source as a regular expression. Default false."),
  response_format: ResponseFormatField,
}).strict();
type CreateRedirectInput = z.infer<typeof CreateRedirectSchema>;

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

function targetOf(r: RawRedirect): string {
  if (typeof r.action_data === "string") return r.action_data;
  return r.action_data?.url ?? "";
}

function formatRedirectLine(r: RawRedirect): string {
  const code = r.action_code ?? "";
  const state = r.enabled === false ? " [disabled]" : "";
  const hits = typeof r.hits === "number" ? ` · ${r.hits} hits` : "";
  return `- \`${r.url}\` → \`${targetOf(r)}\` (${code}, id ${r.id})${state}${hits}`;
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export function registerRedirectionTools(server: McpServer): void {
  // -- wp_list_redirects --
  server.registerTool(
    "wp_list_redirects",
    {
      title: "List Redirects",
      description: `List the 301/302 redirects managed by the Redirection plugin. Requires the plugin to be active and admin rights.

Args:
  - search (string): Optional keyword filter on source/target URLs.
  - per_page (number): Page size, 1-200. Default 50.
  - page (number): 1-based page number. Default 1.
  - response_format (enum): markdown | json.

Returns: { count, total, items: [{ id, url, action_code, action_data, enabled, hits }] }`,
      inputSchema: ListRedirectsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: ListRedirectsInput) => {
      try {
        const r = await makeApiRequest<RawRedirectList | RawRedirect[]>(
          `${REDIRECTION_NS}/redirect`,
          "GET",
          {
            per_page: params.per_page,
            page: params.page,
            ...(params.search ? { filterBy: { url: params.search } } : {}),
          }
        );
        const raw = r.data;
        const items = Array.isArray(raw) ? raw : (raw.items ?? []);
        const total = Array.isArray(raw) ? items.length : (raw.total ?? items.length);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify({ count: items.length, total, items }, null, 2)
          : `# Redirects (${items.length} of ${total})\n\n${items.map(formatRedirectLine).join("\n")}`;
        return toolResult(text, { count: items.length, total, items });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_create_redirect --
  server.registerTool(
    "wp_create_redirect",
    {
      title: "Create a Redirect",
      description: `Create a 301 (or 302/307/308) redirect in the Redirection plugin. Use after any slug change or page re-parenting so the old URL keeps working and search authority transfers.

Requires the Redirection plugin to be active and admin rights.

Args:
  - source (string): Old path to redirect FROM, e.g. '/listen/current-season/'. Required.
  - target (string): Path or URL to redirect TO, e.g. '/concerts/this-season/'. Required.
  - code (301|302|307|308): Default 301 (permanent).
  - title (string): Optional note shown in the admin list.
  - group_id (number): Redirection group. Default 1.
  - regex (boolean): Treat source as a regex. Default false.
  - response_format (enum): markdown | json.

Returns: the created redirect.`,
      inputSchema: CreateRedirectSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: CreateRedirectInput) => {
      try {
        if (params.source === params.target) {
          return toolError(
            "source and target are identical — that would create a redirect loop."
          );
        }

        const body: Record<string, unknown> = {
          url: params.source,
          match_type: "url",
          action_type: "url",
          action_code: params.code,
          action_data: { url: params.target },
          group_id: params.group_id,
          regex: params.regex,
          title: params.title ?? "",
          enabled: true,
        };

        const r = await makeApiRequest<RawRedirect | { item?: RawRedirect }>(
          `${REDIRECTION_NS}/redirect`,
          "POST",
          undefined,
          body
        );
        const created = (r.data as { item?: RawRedirect }).item ?? (r.data as RawRedirect);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(created, null, 2)
          : `Created ${params.code} redirect: \`${params.source}\` → \`${params.target}\`` +
            `${created?.id ? ` (id ${created.id})` : ""}.`;
        return toolResult(text, created);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
