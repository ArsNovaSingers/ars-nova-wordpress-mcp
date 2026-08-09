/**
 * Site Notes read tool.
 *
 * Reads the in-context notes captured by the companion "Ars Nova Site Notes"
 * plugin, which registers admin-only routes under /ans-notes/v1/notes.
 * Core REST does not expose the private `ans_site_note` post type usefully, so
 * this calls the plugin route directly (authenticated via the admin Application
 * Password — the route requires the edit_posts capability).
 *
 * Whichever site the connector points at (DEV kinsta or LIVE) is the source;
 * the caller tags rows by site when syncing to the tracker.
 *
 * Requires: the "Ars Nova Site Notes" plugin active on the target site.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

/** Custom REST route exposed by the Ars Nova Site Notes plugin (under /wp-json). */
const NOTES_ROUTE = "ans-notes/v1/notes";

interface SiteNote {
  id: number;
  text: string;
  page_url: string;
  page_title: string;
  priority: number;
  type: string;
  done: number;
  completed_date: string;
  completed_by: string;
  element_selector: string;
  element_label: string;
  author: string;
  created: string;
}

const ListSiteNotesSchema = z.object({
  status: z.enum(["open", "done", "all"]).optional()
    .describe("Filter by completion state. 'open' = not done, 'done' = completed, 'all' = both. Default 'all'."),
  page_url: z.string().optional()
    .describe("Optional URL path (e.g. /production/here-there/) to return notes for a single page only."),
  response_format: ResponseFormatField,
}).strict();
type ListSiteNotesInput = z.infer<typeof ListSiteNotesSchema>;

export function registerSiteNotesTools(server: McpServer): void {
  server.registerTool(
    "wp_list_site_notes",
    {
      title: "List Site Notes (in-context front-end notes)",
      description: `List the in-context notes/change-tasks captured on the front end via the companion "Ars Nova Site Notes" plugin (must be active). Each note carries page URL/title, priority (1-10), type, done/completed status, who added it + when, and an optional linked element. Use this to sync notes into the project tracker + wiki, or to review what's outstanding on a site.

Whichever site this connector targets (DEV or LIVE) is the source. Run on both connectors and tag rows by site to get the full picture.

Args:
  - status (enum): open | done | all. Default 'all'.
  - page_url (string): optional path filter for a single page.
  - response_format (enum): markdown | json.

Returns: the notes, sorted open-first then priority high->low.`,
      inputSchema: ListSiteNotesSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: ListSiteNotesInput) => {
      try {
        const reqParams = params.page_url ? { page_url: params.page_url } : undefined;
        const r = await makeApiRequest<SiteNote[]>(NOTES_ROUTE, "GET", reqParams);
        let notes = Array.isArray(r.data) ? r.data : [];

        if (params.status === "open") notes = notes.filter((n) => !n.done);
        else if (params.status === "done") notes = notes.filter((n) => !!n.done);

        const openCount = notes.filter((n) => !n.done).length;
        const payload = { count: notes.length, open: openCount, notes };

        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(payload, null, 2)
          : `# Site Notes — ${notes.length} note(s), ${openCount} open\n\n` +
            (notes.length
              ? notes
                  .map(
                    (n) =>
                      `- ${n.done ? "✅" : "⬜"} **P${n.priority}** [${n.type || "general"}] ${n.text}\n` +
                      `  - page: ${n.page_url}${n.page_title ? ` (${n.page_title})` : ""}\n` +
                      `  - by ${n.author || "?"} on ${n.created}` +
                      (n.done && n.completed_date ? ` · done ${n.completed_date}${n.completed_by ? " by " + n.completed_by : ""}` : "") +
                      (n.element_label ? `\n  - linked: ${n.element_label}` : "")
                  )
                  .join("\n")
              : "_No notes._");

        return toolResult(text, payload);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
