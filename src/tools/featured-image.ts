/**
 * wp_set_featured_image — set or clear the featured image on ANY content type.
 *
 * Why this exists (2026-10-01): wc_update_product exposes no image field and
 * wp_set_page_meta only accepts pages/posts, so a WooCommerce product's image
 * could only be changed over SSH with WP-CLI. Core REST already supports it —
 * every post type that declares `thumbnail` support takes `featured_media` on
 * /wp/v2/{rest_base}/{id}. This tool resolves the rest_base from the post type
 * (product, page, post, tc_events, production, ...) so one tool covers them all.
 *
 * Guards: verifies the media item exists and is an image before writing, and
 * reads the value back afterwards. Pass media_id 0 to remove the image.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

interface PostTypeInfo { slug: string; rest_base: string; rest_namespace?: string; name?: string }
interface PostLite { id: number; featured_media: number; title?: { rendered?: string }; link?: string }
interface MediaLite { id: number; media_type?: string; mime_type?: string; source_url?: string }

async function resolveRestBase(postType: string): Promise<string> {
  const r = await makeApiRequest<PostTypeInfo>(`wp/v2/types/${encodeURIComponent(postType)}`, "GET");
  const ns = r.data.rest_namespace || "wp/v2";
  if (ns !== "wp/v2") throw new Error(`Post type '${postType}' is served from ${ns}, not wp/v2.`);
  if (!r.data.rest_base) throw new Error(`Post type '${postType}' is not exposed over REST.`);
  return r.data.rest_base;
}

export function registerFeaturedImageTools(server: McpServer): void {
  server.registerTool(
    "wp_set_featured_image",
    {
      title: "Set Featured Image (any content type)",
      description: `Set or clear the featured image (thumbnail) on any post type: WooCommerce products,
pages, posts, Tickera events (tc_events), productions, etc. Use this for product images —
wc_update_product cannot change them.

Args:
  - post_id (number): ID of the item to change.
  - post_type (string): WordPress post type slug. Default 'post'. Examples: 'product', 'page', 'tc_events'.
  - media_id (number): Media library attachment ID to use. 0 removes the featured image.
  - response_format: markdown | json.

Returns the previous and new featured_media IDs, read back from the site after writing.
Checks the media item exists and is an image before writing.`,
      inputSchema: {
        post_id: z.number().int().positive().describe("ID of the post/page/product to change."),
        post_type: z.string().min(1).default("post").describe("Post type slug, e.g. 'product', 'page', 'post', 'tc_events'."),
        media_id: z.number().int().min(0).describe("Attachment ID for the new featured image; 0 removes it."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params: Record<string, unknown>) => {
      try {
        const postId = params.post_id as number;
        const postType = (params.post_type as string) || "post";
        const mediaId = params.media_id as number;

        if (mediaId > 0) {
          const m = await makeApiRequest<MediaLite>(`wp/v2/media/${mediaId}`, "GET", { context: "edit" });
          if (m.data.media_type && m.data.media_type !== "image") {
            return toolError(`Media ${mediaId} is ${m.data.mime_type || m.data.media_type}, not an image. Nothing changed.`);
          }
        }

        const base = await resolveRestBase(postType);
        const path = `wp/v2/${base}/${postId}`;
        const before = await makeApiRequest<PostLite>(path, "GET", { context: "edit", _fields: "id,featured_media" });
        const previous = before.data.featured_media ?? 0;

        await makeApiRequest<PostLite>(path, "POST", undefined, { featured_media: mediaId });

        const after = await makeApiRequest<PostLite>(path, "GET", { context: "edit", _fields: "id,featured_media,title,link" });
        const current = after.data.featured_media ?? 0;
        if (current !== mediaId) {
          return toolError(`Write did not stick: ${postType} ${postId} reads featured_media=${current}, expected ${mediaId}. ` +
            `The post type may not declare 'thumbnail' support.`);
        }

        const result = { post_id: postId, post_type: postType, previous_media_id: previous, media_id: current,
                         title: after.data.title?.rendered, link: after.data.link };
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(result, null, 2)
          : `Featured image on ${postType} **${postId}** (${result.title ?? ""}) changed: ${previous} → **${current}**` +
            (previous === current ? " (already set; no change)" : "") + ". Read back from the site.";
        return toolResult(text, result);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
