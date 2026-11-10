/**
 * Media tools — list, inspect, upload, update, and delete items in the WP media library.
 */
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import FormData from "form-data";

import { getWpClient, makeApiRequest, wpV2 } from "../services/wp-client.js";
import {
  buildPaginated,
  enforceCharLimit,
  renderResponse,
  stripHtml,
  toolError,
  toolResult,
} from "../services/formatters.js";
import {
  OrderEnum,
  PaginationSchema,
  ResponseFormatField,
} from "../schemas/common.js";
import { ResponseFormat, type WPMediaItem } from "../types.js";
import {
  SIDELOAD_ROUTE,
  formatSideloadMarkdown,
  planUpload,
  type SideloadResult,
} from "./media-sideload.js";

interface RawWpMedia {
  id: number;
  date: string;
  slug: string;
  title?: { rendered?: string };
  alt_text?: string;
  caption?: { rendered?: string };
  description?: { rendered?: string };
  media_type: string;
  mime_type: string;
  source_url: string;
  author: number;
  post: number;
  media_details?: {
    width?: number;
    height?: number;
    filesize?: number;
  };
}

function transformMedia(raw: RawWpMedia): WPMediaItem {
  return {
    id: raw.id,
    date: raw.date,
    slug: raw.slug,
    title: stripHtml(raw.title?.rendered),
    alt_text: raw.alt_text || "",
    caption: stripHtml(raw.caption?.rendered),
    description: stripHtml(raw.description?.rendered),
    media_type: raw.media_type,
    mime_type: raw.mime_type,
    source_url: raw.source_url,
    file_size: raw.media_details?.filesize,
    width: raw.media_details?.width,
    height: raw.media_details?.height,
    author_id: raw.author,
    attached_to_id: raw.post,
  };
}

function formatMediaItemMarkdown(item: WPMediaItem): string {
  const lines = [
    `## ${item.title || "(untitled)"} (ID ${item.id})`,
    `- **Type**: ${item.media_type} (${item.mime_type})`,
    `- **URL**: ${item.source_url}`,
    `- **Alt text**: ${item.alt_text || "_(missing)_"}`,
  ];
  if (item.width && item.height) lines.push(`- **Dimensions**: ${item.width}x${item.height}`);
  if (item.file_size) lines.push(`- **File size**: ${(item.file_size / 1024).toFixed(1)} KB`);
  if (item.caption) lines.push(`- **Caption**: ${item.caption}`);
  if (item.attached_to_id) lines.push(`- **Attached to post ID**: ${item.attached_to_id}`);
  return lines.join("\n");
}

const ListMediaInputSchema = PaginationSchema.extend({
  media_type: z.enum(["image", "video", "audio", "file", "any"]).default("any")
    .describe("Filter to a single media type, or 'any' for all."),
  search: z.string().optional()
    .describe("Search term to match against title, caption, alt text."),
  parent: z.number().int().min(0).optional()
    .describe("Filter to media attached to this post/page ID. Use 0 for unattached."),
  orderby: z.enum(["date", "title", "id", "modified"]).default("date")
    .describe("Sort field."),
  order: OrderEnum.default("desc")
    .describe("Sort direction."),
  response_format: ResponseFormatField,
}).strict();

const GetMediaItemInputSchema = z.object({
  id: z.number().int().positive()
    .describe("Numeric media item ID."),
  response_format: ResponseFormatField,
}).strict();

type ListMediaInput = z.infer<typeof ListMediaInputSchema>;
type GetMediaItemInput = z.infer<typeof GetMediaItemInputSchema>;

// -----------------------------------------------------------------------------
// Write schemas (Phase 2)
// -----------------------------------------------------------------------------

const UploadMediaInputSchema = z.object({
  source_url: z.string().url().optional()
    .describe("Public https:// URL of the file. The WordPress site downloads it itself."),
  drive_file_id: z.string().min(1).optional()
    .describe("Google Drive file id. The site fetches it privately with the org's Google service account (the file or its Shared Drive must be shared with it). Best choice for files on the H: drive."),
  base64_content: z.string().min(1).optional()
    .describe("File bytes as base64 (a data: prefix is fine). Needs filename and sha256. Last resort: base64 relayed through a conversation can arrive truncated."),
  filename: z.string().min(1).optional()
    .describe("Filename with extension. Required with base64_content; optional otherwise (the extension is corrected to the real type)."),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional()
    .describe("sha256 of the original file. Required with base64_content; checked if given for other sources."),
  file_path: z.string().min(1).optional()
    .describe("Path to a file on the CONNECTOR'S OWN HOST. On the hosted (Cloud Run) connector this is never your PC, so use drive_file_id or source_url instead."),
  title: z.string().optional()
    .describe("Title for the media item. Defaults to the filename minus extension."),
  alt_text: z.string().optional()
    .describe("Alt text for accessibility. Strongly recommended for images."),
  caption: z.string().optional()
    .describe("Caption shown beneath the image in some themes."),
  description: z.string().optional()
    .describe("Longer description (rendered on the attachment page)."),
  post: z.number().int().min(0).optional()
    .describe("Same as attach_to_post (kept for older callers)."),
  attach_to_post: z.number().int().min(0).optional()
    .describe("Attach this media to a post/page ID. 0 (default) = unattached."),
  set_featured_on: z.array(z.number().int().positive()).max(50).optional()
    .describe("Post IDs to set this image as the featured image on, e.g. a page, a Tickera event and its ticket products. Every id is checked before anything uploads."),
  confirm_production: z.boolean().optional()
    .describe("Required (true) on the LIVE site."),
  response_format: ResponseFormatField,
}).strict();

const UpdateMediaInputSchema = z.object({
  id: z.number().int().positive()
    .describe("Media item ID to update."),
  title: z.string().optional()
    .describe("New title."),
  alt_text: z.string().optional()
    .describe("New alt text. Pass empty string to clear."),
  caption: z.string().optional()
    .describe("New caption."),
  description: z.string().optional()
    .describe("New description."),
  post: z.number().int().min(0).optional()
    .describe("Reassign to a different post/page ID. 0 = unattach."),
  response_format: ResponseFormatField,
}).strict();

const DeleteMediaInputSchema = z.object({
  id: z.number().int().positive()
    .describe("Media item ID to delete."),
  force: z.boolean().default(true)
    .describe("NOTE: WP REST requires force=true for media — there is no trash for media. Default is true. Setting false will trigger a WP validation error."),
  response_format: ResponseFormatField,
}).strict();

type UploadMediaInput = z.infer<typeof UploadMediaInputSchema>;
type UpdateMediaInput = z.infer<typeof UpdateMediaInputSchema>;
type DeleteMediaInput = z.infer<typeof DeleteMediaInputSchema>;

/**
 * Guess MIME type from a filename extension. WP only needs this approximately —
 * the server will sniff the actual bytes too.
 */
function guessMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}

export function registerMediaTools(server: McpServer): void {
  server.registerTool(
    "wp_list_media",
    {
      title: "List WordPress Media Library",
      description: `List items in the WP media library with filtering and pagination.

Args:
  - limit (number): Page size, 1-100. Default 20.
  - offset (number): Pagination offset.
  - media_type (enum): image | video | audio | file | any. Default 'any'.
  - search (string): Optional keyword filter.
  - parent (number): Optional attachment-to-post-ID filter (0 = unattached).
  - orderby (enum): date | title | id | modified. Default 'date'.
  - order (enum): asc | desc. Default 'desc'.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  Paginated envelope of WPMediaItem objects with shape:
  { id, date, slug, title, alt_text, caption, description, media_type, mime_type, source_url, file_size, width, height, author_id, attached_to_id }`,
      inputSchema: ListMediaInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListMediaInput) => {
      try {
        const wpParams: Record<string, unknown> = {
          per_page: params.limit,
          offset: params.offset,
          orderby: params.orderby,
          order: params.order,
        };
        if (params.media_type !== "any") wpParams.media_type = params.media_type;
        if (params.search) wpParams.search = params.search;
        if (params.parent !== undefined) wpParams.parent = params.parent;

        const result = await makeApiRequest<RawWpMedia[]>(wpV2("media"), "GET", wpParams);
        const items = result.data.map(transformMedia);
        const envelope = enforceCharLimit(buildPaginated(items, result.total, params.offset));
        const text = renderResponse(envelope, params.response_format, "Media Library", formatMediaItemMarkdown);
        return toolResult(text, envelope);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "wp_get_media_item",
    {
      title: "Get WordPress Media Item",
      description: `Fetch a single media item by ID. Returns full metadata including dimensions, file size, MIME type, alt text, caption, and source URL.

Args:
  - id (number): Numeric media item ID.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  A single WPMediaItem object.`,
      inputSchema: GetMediaItemInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetMediaItemInput) => {
      try {
        const result = await makeApiRequest<RawWpMedia>(wpV2(`media/${params.id}`));
        const item = transformMedia(result.data);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : formatMediaItemMarkdown(item);
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Phase 2 — Write tools
  // ---------------------------------------------------------------------------

  // -- wp_upload_media --
  server.registerTool(
    "wp_upload_media",
    {
      title: "Upload File to WordPress Media Library",
      description: `Add a file to the WordPress Media Library, and optionally make it the featured image on pages, events or products in the same call. No local file needed.

Give exactly ONE source:
  - drive_file_id: a Google Drive file id (best for anything on the H: drive). The site fetches it privately.
  - source_url: a public https:// URL. The site downloads it.
  - base64_content + filename + sha256: raw bytes. Last resort; base64 relayed through a conversation can arrive truncated.
  - file_path: a file on the connector's OWN host. The hosted connector runs on Cloud Run, so this is never your PC.

Options: title, alt_text (always set it for images), caption, description, attach_to_post (alias: post), set_featured_on (array of post ids), confirm_production (required on LIVE).

Rules (enforced by the site's ars-nova-media plugin, route ans-ops/v1/media/sideload): 20 MB cap; JPEG, PNG, WebP, GIF, SVG or PDF only, judged from the file's bytes; unsafe SVG refused. Every post id is checked before anything uploads. file_path files of other types or over 20 MB fall back to the old wp/v2 upload (no set_featured_on).

Returns the media id, source_url, the generated sizes, which posts it became featured on, and the site it landed on.`,
      inputSchema: UploadMediaInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: UploadMediaInput) => {
      try {
        const plan = planUpload(
          {
            ...params,
            file_path: params.file_path
              ? (isAbsolute(params.file_path) ? params.file_path : resolvePath(process.cwd(), params.file_path))
              : undefined,
          },
          (p) => readFileSync(p)
        );
        if (plan.kind === "error") return toolError(plan.message);

        if (plan.kind === "sideload") {
          // Direct client call rather than makeApiRequest: a base64 body for a
          // 20 MB file is ~27 MB, over axios' default 10 MB request cap.
          const response = await getWpClient().post(`/${SIDELOAD_ROUTE}`, plan.body, {
            timeout: 180_000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
          });
          if (response.status === 404) {
            return toolError(
              "This site has no ans-ops/v1/media/sideload route. It needs the ars-nova-media plugin 1.2.0 or newer."
            );
          }
          if (response.status >= 400) {
            const body = response.data as { code?: string; message?: string } | undefined;
            return toolError(
              `Upload refused (HTTP ${response.status})${body?.code ? ` [${body.code}]` : ""}` +
              `${body?.message ? `: ${body.message}` : ""}`
            );
          }
          const result = response.data as SideloadResult;
          const text = params.response_format === ResponseFormat.JSON
            ? JSON.stringify(result, null, 2)
            : formatSideloadMarkdown(result, plan.label);
          return toolResult(text, result as unknown as Record<string, unknown>);
        }

        // Legacy: a file on this host that the sideload route does not take.
        const filePath = plan.filePath;
        const buffer = readFileSync(filePath);
        const filename = basename(filePath);
        const mimeType = guessMimeType(filename);

        const form = new FormData();
        form.append("file", buffer, { filename, contentType: mimeType });
        if (params.title) form.append("title", params.title);
        if (params.alt_text !== undefined) form.append("alt_text", params.alt_text);
        if (params.caption !== undefined) form.append("caption", params.caption);
        if (params.description !== undefined) form.append("description", params.description);
        const attachTo = params.attach_to_post ?? params.post;
        if (attachTo !== undefined) form.append("post", String(attachTo));

        const client = getWpClient();
        const response = await client.post(`/${wpV2("media")}`, form, {
          headers: form.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        });

        if (response.status >= 400) {
          const body = response.data as { code?: string; message?: string } | undefined;
          return toolError(
            `WP rejected upload (HTTP ${response.status})${body?.code ? ` [${body.code}]` : ""}` +
            `${body?.message ? `: ${body.message}` : ""}`
          );
        }

        const item = transformMedia(response.data as RawWpMedia);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : `# Uploaded ${filename} (ID ${item.id})\n\n${formatMediaItemMarkdown(item)}`;
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_update_media --
  server.registerTool(
    "wp_update_media",
    {
      title: "Update WordPress Media Item",
      description: `Update metadata on an existing media item — title, alt text, caption, description, or attachment target. Most common use: backfilling alt_text on images that don't have it.

Args:
  - id (number): Media item ID. Required.
  - alt_text (string): New alt text. Pass empty string to clear.
  - title, caption, description (string): Optional.
  - post (number): Reassign to a different post/page ID (0 = unattach).
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  The updated WPMediaItem.`,
      inputSchema: UpdateMediaInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: UpdateMediaInput) => {
      try {
        const { id, response_format, ...rest } = params;
        const payload: Record<string, unknown> = {};
        for (const key of ["title", "alt_text", "caption", "description", "post"] as const) {
          if ((rest as Record<string, unknown>)[key] !== undefined) {
            payload[key] = (rest as Record<string, unknown>)[key];
          }
        }
        if (Object.keys(payload).length === 0) {
          return toolError("Pass at least one field to update (alt_text, title, caption, description, post).");
        }
        const result = await makeApiRequest<RawWpMedia>(wpV2(`media/${id}`), "PUT", undefined, payload);
        const item = transformMedia(result.data);
        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : `# Updated media (ID ${item.id})\n\nFields changed: ${Object.keys(payload).join(", ")}\n\n${formatMediaItemMarkdown(item)}`;
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_delete_media --
  server.registerTool(
    "wp_delete_media",
    {
      title: "Delete WordPress Media Item",
      description: `Permanently delete a media item. WP REST does NOT support trashing media; deletion is always permanent.

Args:
  - id (number): Media item ID. Required.
  - force (boolean): Default true. False will trigger a WP validation error.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  { deleted: true, previous: <full media object> }`,
      inputSchema: DeleteMediaInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: DeleteMediaInput) => {
      try {
        const result = await makeApiRequest<{ deleted?: boolean; previous?: RawWpMedia }>(
          wpV2(`media/${params.id}`),
          "DELETE",
          { force: params.force }
        );
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(result.data, null, 2)
          : `# Media ${params.id} permanently deleted.`;
        return toolResult(text, result.data as object);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
