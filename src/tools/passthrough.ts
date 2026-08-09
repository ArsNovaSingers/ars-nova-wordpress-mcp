/**
 * Generic passthrough to OUR OWN WordPress REST namespaces.
 *
 * Why this exists: every capability we add to one of the Ars Nova site plugins
 * used to need a matching hand-written tool in this connector, a rebuild, and a
 * Claude Desktop restart. That asymmetry meant endpoints got built and then sat
 * uncallable — e.g. the Tickera event update/delete routes shipped in
 * ars-nova-ticketing-bridge v1.1.0 and could not be used for hours. One generic
 * caller removes that: add a route to a plugin, deploy it, use it immediately.
 *
 * SCOPE GUARD: this deliberately CANNOT call arbitrary WordPress or third-party
 * REST routes. It is restricted to the namespaces we author ourselves. Core
 * wp/v2, WooCommerce and third-party plugin routes keep their own purpose-built
 * tools, which carry validation and safety rails this cannot.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

/**
 * Namespaces this tool may reach. All are plugins we wrote and control.
 * Adding to this list is a deliberate act — do not widen it to wp/v2 or wc/v3.
 */
const ALLOWED_NAMESPACES = [
  "ars-nova/v1", // ars-nova-ticketing-bridge (Tickera + Bridge management)
  "ans-ops/v1",  // ars-nova-ops (plugin installer)
  "ans-notes/v1", // ars-nova-site-notes
  "ansg/v1",     // ars-nova-google-connector
] as const;

const CallSchema = z.object({
  namespace: z.enum(ALLOWED_NAMESPACES)
    .describe("Which of our own REST namespaces to call. Restricted by design."),
  route: z.string().min(1)
    .describe("Route within the namespace, no leading slash. e.g. 'tickera/introspect' or 'tickera/event/6665'."),
  // No PATCH: the shared wp-client only supports these four. WordPress REST
  // treats POST as an update on an existing resource anyway, so nothing is lost.
  method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET")
    .describe("HTTP method. Default GET. Use POST to update an existing resource."),
  query: z.record(z.any()).optional()
    .describe("Query-string parameters as an object, e.g. { event_id: 6633, per_page: 20 }."),
  body: z.record(z.any()).optional()
    .describe("JSON body for POST/PUT/PATCH, e.g. { title: 'Cross Currents — May 21' }."),
  response_format: ResponseFormatField,
}).strict();
type CallInput = z.infer<typeof CallSchema>;

export function registerPassthroughTools(server: McpServer): void {
  server.registerTool(
    "ans_rest_call",
    {
      title: "Call an Ars Nova plugin REST route",
      description: `Call any route in one of the Ars Nova plugins' own REST namespaces. Use this for capabilities that have no dedicated tool yet — it means a new plugin endpoint is usable the moment it is deployed, with no connector rebuild.

RESTRICTED BY DESIGN to namespaces we author: ars-nova/v1, ans-ops/v1, ans-notes/v1, ansg/v1. It cannot call wp/v2, wc/v3 or third-party plugin routes — those have their own purpose-built tools with validation this does not provide.

Environment safety: this goes through the same client as every other tool, so it hits whichever site this connector is configured for. Call wp_check_environment first if you are unsure whether you are on DEV or LIVE.

Useful ars-nova/v1 routes (ars-nova-ticketing-bridge v1.4.0):
  - GET  tickera/introspect              — what is ACTUALLY registered: shortcodes, post types, taxonomies, ticket-product meta keys. Use this instead of assuming.
  - GET  tickera/status
  - GET  tickera/events | tickera/event/{id}
  - POST tickera/event/{id}              — update title/date/location/status
  - DEL  tickera/event/{id}              — trash (?force=1 to delete)
  - GET  tickera/ticket-types | tickera/ticket-type/{id}
  - POST tickera/ticket-type/{id}        — update price/status/template/stock/virtual
  - POST tickera/assign-template         — { template_id, event_id?, product_ids? }
  - GET  tickera/event-categories        — the season's "projects"
  - POST tickera/event-categories        — { name, slug?, description?, ans_page_id? }
  - POST tickera/event-category/{id}     — rename, re-describe, re-link, reassign events
  - GET  tickera/attendees               — issued tickets

Args:
  - namespace (enum): one of the allowed namespaces. Required.
  - route (string): path within it, no leading slash. Required.
  - method (enum): GET | POST | PUT | PATCH | DELETE. Default GET.
  - query (object): query-string parameters.
  - body (object): JSON body for writes.
  - response_format (enum): markdown | json.

Returns: the endpoint's JSON response verbatim.`,
      inputSchema: CallSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: CallInput) => {
      try {
        const ns = params.namespace;
        if (!ALLOWED_NAMESPACES.includes(ns)) {
          return toolError(
            `Namespace "${ns}" is not allowed. Permitted: ${ALLOWED_NAMESPACES.join(", ")}.`
          );
        }

        // Normalise the route: strip leading/trailing slashes, reject traversal
        // and any attempt to hop out of the namespace.
        const route = params.route.replace(/^\/+/, "").replace(/\/+$/, "");
        if (route === "" || route.includes("..")) {
          return toolError(`Invalid route "${params.route}".`);
        }
        if (route.startsWith("wp/") || route.startsWith("wc/")) {
          return toolError(
            `Route "${route}" looks like it targets another namespace. This tool only calls ${ALLOWED_NAMESPACES.join(", ")}.`
          );
        }

        const endpoint = `${ns}/${route}`;
        const method = params.method ?? "GET";

        const r = await makeApiRequest<object>(
          endpoint,
          method,
          params.query ?? {},
          params.body
        );

        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : `# ${method} ${endpoint}\n\n\`\`\`json\n${JSON.stringify(r.data, null, 2)}\n\`\`\``;

        return toolResult(text, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
