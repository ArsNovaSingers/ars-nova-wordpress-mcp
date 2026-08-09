/**
 * Raw block-content read + per-page meta write.
 *
 * The normal content tools (wp_get_page / wp_get_post) strip HTML to plain text.
 * These read the RAW Gutenberg block markup (via core REST context=edit) so page
 * content can be inspected, transformed, and rewritten by command — and write
 * per-page meta (e.g. Kadence per-page settings like _kad_post_title) which the
 * page-update tool doesn't expose.
 *
 * Requires admin (the configured Application Password user).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest, wpV2 } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

function restBase(type: string): string {
  return type === "post" ? "posts" : "pages";
}

/** Remove a LEADING core/cover block (the embedded hero) from block markup, if present. */
function stripLeadingCover(raw: string): { changed: boolean; content: string } {
  const lead = raw.replace(/^﻿?\s+/, "");
  if (!lead.startsWith("<!-- wp:cover")) return { changed: false, content: raw };
  const marker = "<!-- /wp:cover -->";
  const idx = lead.indexOf(marker);
  if (idx === -1) return { changed: false, content: raw };
  const after = lead.slice(idx + marker.length).replace(/^\s+/, "");
  return { changed: true, content: after };
}

const GetRawSchema = z.object({
  id: z.number().int().describe("Page or post ID."),
  type: z.enum(["page", "post"]).default("page").describe("Content type. Default 'page'."),
  response_format: ResponseFormatField,
}).strict();
type GetRawInput = z.infer<typeof GetRawSchema>;

const SetMetaSchema = z.object({
  id: z.number().int().describe("Page or post ID."),
  type: z.enum(["page", "post"]).default("page").describe("Content type. Default 'page'."),
  meta: z.record(z.any()).describe("Meta key:value pairs to set (e.g. Kadence per-page keys like _kad_post_title). Only REST-registered meta keys are writable."),
  response_format: ResponseFormatField,
}).strict();
type SetMetaInput = z.infer<typeof SetMetaSchema>;

const StripCoverSchema = z.object({
  ids: z.array(z.number().int()).min(1).describe("Page/post IDs to strip the leading core/cover hero from."),
  type: z.enum(["page", "post"]).default("page").describe("Content type. Default 'page'."),
  dry_run: z.boolean().default(false).describe("If true, report what would change WITHOUT saving."),
  response_format: ResponseFormatField,
}).strict();
type StripCoverInput = z.infer<typeof StripCoverSchema>;

export function registerRawContentTools(server: McpServer): void {
  server.registerTool(
    "wp_get_raw_content",
    {
      title: "Get Raw Block Content",
      description: `Read a page/post's RAW Gutenberg block markup (comment-delimited blocks), via core REST with context=edit. This is the editable source that wp_get_page/wp_get_post strip away. Use to inspect and transform page content, then write it back with wp_update_page. Requires admin.

Args:
  - id (number): page/post ID.
  - type ('page' | 'post'): default 'page'.
  - response_format (enum): markdown | json.

Returns: { id, title, slug, content } where content is the raw block markup.`,
      inputSchema: GetRawSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: GetRawInput) => {
      try {
        const endpoint = wpV2(`${restBase(params.type)}/${params.id}`);
        const r = await makeApiRequest<Record<string, any>>(endpoint, "GET", { context: "edit" });
        const content = r.data?.content?.raw ?? "";
        const title = r.data?.title?.raw ?? r.data?.title?.rendered ?? "";
        const payload = { id: r.data?.id, title, slug: r.data?.slug, content, meta: r.data?.meta ?? {} };
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(payload, null, 2)
          : `# ${title} (id ${payload.id}) — raw blocks\n\n\`\`\`html\n${content}\n\`\`\``;
        return toolResult(text, payload);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "wp_set_page_meta",
    {
      title: "Set Page/Post Meta",
      description: `Write post meta on a page/post (e.g. Kadence per-page settings such as _kad_post_title to disable the title on one page). POSTs { meta: {...} } to core REST. Only REST-registered meta keys can be written. Requires admin.

Args:
  - id (number): page/post ID.
  - type ('page' | 'post'): default 'page'.
  - meta (object): key:value pairs to set.
  - response_format (enum): markdown | json.

Returns: the updated meta object.`,
      inputSchema: SetMetaSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params: SetMetaInput) => {
      try {
        const endpoint = wpV2(`${restBase(params.type)}/${params.id}`);
        const r = await makeApiRequest<Record<string, any>>(endpoint, "POST", undefined, { meta: params.meta });
        const updated = r.data?.meta ?? {};
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(updated, null, 2)
          : `# Meta updated (id ${r.data?.id})\n\n` +
            Object.entries(params.meta).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`).join("\n");
        return toolResult(text, { id: r.data?.id, meta: updated });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "wp_strip_leading_cover",
    {
      title: "Strip Leading Cover Hero",
      description: `Remove the embedded leading core/cover hero block from one or more pages, so the theme's page-title bar takes over. SAFE: only removes a block that is BOTH the first block AND a core/cover; pages without a leading cover are left unchanged. Reads/strips/writes server-side (no page content passes through the client), so it scales to many pages in one call. Requires admin.

Args:
  - ids (number[]): page/post IDs.
  - type ('page' | 'post'): default 'page'.
  - dry_run (bool): if true, report what would change WITHOUT saving.
  - response_format (enum): markdown | json.

Returns: per-id { title, removedCover, saved }.`,
      inputSchema: StripCoverSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params: StripCoverInput) => {
      try {
        const results: Array<Record<string, unknown>> = [];
        for (const id of params.ids) {
          try {
            const endpoint = wpV2(`${restBase(params.type)}/${id}`);
            const r = await makeApiRequest<Record<string, any>>(endpoint, "GET", { context: "edit" });
            const raw = r.data?.content?.raw ?? "";
            const { changed, content } = stripLeadingCover(raw);
            if (changed && !params.dry_run) {
              await makeApiRequest(endpoint, "POST", undefined, { content });
            }
            results.push({
              id,
              title: r.data?.title?.raw ?? r.data?.title?.rendered ?? "",
              removedCover: changed,
              saved: changed && !params.dry_run,
            });
          } catch (e) {
            results.push({ id, error: e instanceof Error ? e.message : String(e) });
          }
        }
        const payload = { dry_run: params.dry_run, results };
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(payload, null, 2)
          : `# Strip leading cover (${params.dry_run ? "DRY RUN" : "applied"})\n\n` +
            results
              .map((x) =>
                x.error
                  ? `- ${x.id}: ERROR ${x.error}`
                  : `- ${x.id} ${x.title || ""}: ${x.removedCover ? (x.saved ? "removed ✓" : "would remove") : "no leading cover (skipped)"}`
              )
              .join("\n");
        return toolResult(text, payload);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
