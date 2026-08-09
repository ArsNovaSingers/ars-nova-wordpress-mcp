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
  file_path: z.string().min(1)
    .describe("Absolute path to a local file to upload. Must be readable by the MCP process. (For files in your workspace folder, use the full Windows path.)"),
  title: z.string().optional()
    .describe("Title for the media item. Defaults to the filename minus extension."),
  alt_text: z.string().optional()
    .describe("Alt text for accessibility. Strongly recommended for images."),
  caption: z.string().optional()
    .describe("Caption shown beneath the image in some themes."),
  description: z.string().optional()
    .describe("Longer description (rendered on the attachment page)."),
  post: z.number().int().min(0).optional()
    .describe("Attach this media to a specific post/page ID. 0 (default) = unattached."),
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
      description: `Upload a local file to the WP media library as a new attachment. Reads the file from file_path on the MCP host machine, sends as multipart/form-data, and returns the created media item.

Args:
  - file_path (string): Absolute path to the file on disk. Required.
  - title (string): Optional title (defaults to filename).
  - alt_text (string): Optional alt text.
  - caption (string): Optional caption.
  - description (string): Optional description.
  - post (number): Optional post/page ID to attach the media to (0 = unattached).
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  The newly-created WPMediaItem with id, source_url, dimensions, etc.

Notes:
  - The MCP host process must have read access to file_path.
  - For best SEO, always pass alt_text on image uploads.
  - WP MIME-sniffs the file; the upload will be rejected if the extension is on
    WP's disallowed list (e.g. executables).`,
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
        const filePath = isAbsolute(params.file_path)
          ? params.file_path
          : resolvePath(process.cwd(), params.file_path);

        let buffer: Buffer;
        try {
          buffer = readFileSync(filePath);
        } catch (e) {
          return toolError(
            `Could not read file at '${filePath}': ${e instanceof Error ? e.message : String(e)}. ` +
            `Use an absolute path readable by the MCP process.`
          );
        }

        const filename = basename(filePath);
        const mimeType = guessMimeType(filename);

        const form = new FormData();
        form.append("file", buffer, { filename, contentType: mimeType });
        if (params.title) form.append("title", params.title);
        if (params.alt_text !== undefined) form.append("alt_text", params.alt_text);
        if (params.caption !== undefined) form.append("caption", params.caption);
        if (params.description !== undefined) form.append("description", params.description);
        if (params.post !== undefined) form.append("post", String(params.post));

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
