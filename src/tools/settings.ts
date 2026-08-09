/**
 * Settings write tool — update WordPress general settings via /wp/v2/settings.
 *
 * Requires admin (manage_options). Reading settings already lives in site.ts
 * (wp_get_settings / wp_get_site_info); this module adds the writer.
 *
 * NOTE: the core /wp/v2/settings endpoint only exposes a fixed set of options.
 * The search-engine-visibility flag ("blog_public" / Discourage search engines)
 * is NOT exposed by core and cannot be set here — it needs the companion
 * control plugin (planned) or the WP Admin Reading screen. The fields below are
 * the ones core exposes and that matter for a rebuild (homepage assignment,
 * blog page, title/tagline, posts-per-page).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest, wpV2 } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

const UpdateSettingsSchema = z.object({
  title: z.string().optional().describe("Site title."),
  description: z.string().optional().describe("Site tagline."),
  posts_per_page: z.number().int().min(1).optional().describe("Blog posts shown per page."),
  show_on_front: z.enum(["posts", "page"]).optional()
    .describe("What the front page shows: 'posts' (latest blog) or 'page' (a static page)."),
  page_on_front: z.number().int().optional()
    .describe("Page ID to use as the static homepage (only used when show_on_front='page')."),
  page_for_posts: z.number().int().optional()
    .describe("Page ID to use as the blog/posts page (only used when show_on_front='page')."),
  default_category: z.number().int().optional().describe("Default category ID for new posts."),
  response_format: ResponseFormatField,
}).strict();
type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;

export function registerSettingsTools(server: McpServer): void {
  server.registerTool(
    "wp_update_settings",
    {
      title: "Update WordPress Settings",
      description: `Update core WP general settings (title, tagline, posts-per-page, and the front-page / blog-page assignment). Requires admin (manage_options). Only the fields you pass are changed.

The most common use is setting the static homepage:
  show_on_front='page', page_on_front=<homepage page ID>, page_for_posts=<blog page ID>.

NOTE: This cannot toggle "Discourage search engines" (blog_public) — core does not expose it via REST. Use the WP Admin Reading screen or the planned control plugin for that.

Args:
  - title, description (string)
  - posts_per_page (number)
  - show_on_front ('posts' | 'page')
  - page_on_front, page_for_posts, default_category (number)
  - response_format (enum): markdown | json.

Returns: the updated settings object.`,
      inputSchema: UpdateSettingsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: UpdateSettingsInput) => {
      try {
        const body: Record<string, unknown> = {};
        if (params.title !== undefined) body.title = params.title;
        if (params.description !== undefined) body.description = params.description;
        if (params.posts_per_page !== undefined) body.posts_per_page = params.posts_per_page;
        if (params.show_on_front !== undefined) body.show_on_front = params.show_on_front;
        if (params.page_on_front !== undefined) body.page_on_front = params.page_on_front;
        if (params.page_for_posts !== undefined) body.page_for_posts = params.page_for_posts;
        if (params.default_category !== undefined) body.default_category = params.default_category;

        if (Object.keys(body).length === 0) {
          return toolError("No settings provided to update. Pass at least one field.");
        }

        const r = await makeApiRequest<Record<string, unknown>>(wpV2("settings"), "POST", undefined, body);
        const changed = Object.keys(body).join(", ");
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : `# Settings updated\n\nChanged: ${changed}\n\n` +
            Object.entries(r.data)
              .map(([k, v]) => `- **${k}**: ${typeof v === "string" ? v : JSON.stringify(v)}`)
              .join("\n");
        return toolResult(text, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
