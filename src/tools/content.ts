/**
 * Content tools — posts, pages, and cross-content search.
 *
 * All tools are read-only. Phase 2 will add create/update tools alongside.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";

import { makeApiRequest, wpV2 } from "../services/wp-client.js";
import {
  buildPaginated,
  enforceCharLimit,
  renderResponse,
  stripHtml,
  toolError,
  toolResult,
  truncate,
} from "../services/formatters.js";
import {
  ContentOrderByEnum,
  ContentStatusEnum,
  OrderEnum,
  PaginationSchema,
  ResponseFormatField,
} from "../schemas/common.js";
import { ResponseFormat, type WPContentItem } from "../types.js";

// -----------------------------------------------------------------------------
// Shared transformation: WP REST raw post/page object -> our trimmed shape
// -----------------------------------------------------------------------------

interface RawWpContent {
  id: number;
  date: string;
  modified: string;
  slug: string;
  status: string;
  type: string;
  link: string;
  title?: { rendered?: string };
  excerpt?: { rendered?: string };
  content?: { rendered?: string };
  author: number;
  featured_media: number;
  categories?: number[];
  tags?: number[];
  parent?: number;
  menu_order?: number;
}

function transformContent(raw: RawWpContent): WPContentItem {
  const fullContent = stripHtml(raw.content?.rendered);
  return {
    id: raw.id,
    date: raw.date,
    modified: raw.modified,
    slug: raw.slug,
    status: raw.status,
    type: raw.type,
    link: raw.link,
    title: stripHtml(raw.title?.rendered),
    excerpt: stripHtml(raw.excerpt?.rendered),
    content_preview: truncate(fullContent, 500),
    author_id: raw.author,
    featured_media_id: raw.featured_media,
    ...(raw.categories ? { categories: raw.categories } : {}),
    ...(raw.tags ? { tags: raw.tags } : {}),
    ...(raw.parent !== undefined ? { parent: raw.parent } : {}),
    ...(raw.menu_order !== undefined ? { menu_order: raw.menu_order } : {}),
  };
}

function formatContentItemMarkdown(item: WPContentItem): string {
  const lines = [
    `## ${item.title || "(untitled)"} (ID ${item.id})`,
    `- **Type**: ${item.type}`,
    `- **Status**: ${item.status}`,
    `- **Slug**: ${item.slug}`,
    `- **URL**: ${item.link}`,
    `- **Modified**: ${item.modified}`,
    `- **Author ID**: ${item.author_id}`,
  ];
  if (item.featured_media_id) lines.push(`- **Featured media ID**: ${item.featured_media_id}`);
  if (item.categories?.length) lines.push(`- **Categories**: ${item.categories.join(", ")}`);
  if (item.tags?.length) lines.push(`- **Tags**: ${item.tags.join(", ")}`);
  if (item.parent !== undefined && item.parent > 0) lines.push(`- **Parent page ID**: ${item.parent}`);
  if (item.menu_order !== undefined) lines.push(`- **Menu order**: ${item.menu_order}`);
  if (item.excerpt) lines.push(`- **Excerpt**: ${truncate(item.excerpt, 200)}`);
  if (item.content_preview) lines.push(`- **Content preview**: ${item.content_preview}`);
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const ListPostsInputSchema = PaginationSchema.extend({
  status: ContentStatusEnum.default("publish")
    .describe("Filter by status. 'any' returns all statuses (requires edit_posts capability)."),
  search: z.string().optional()
    .describe("Search term to match against title and content."),
  author: z.number().int().positive().optional()
    .describe("Filter to posts by this author ID."),
  categories: z.array(z.number().int().positive()).optional()
    .describe("Filter to posts in any of these category IDs."),
  tags: z.array(z.number().int().positive()).optional()
    .describe("Filter to posts in any of these tag IDs."),
  orderby: ContentOrderByEnum.default("date")
    .describe("Field to sort by."),
  order: OrderEnum.default("desc")
    .describe("Sort direction."),
  response_format: ResponseFormatField,
}).strict();

const GetPostInputSchema = z.object({
  id: z.number().int().positive().optional()
    .describe("Numeric post ID. Either id OR slug is required."),
  slug: z.string().optional()
    .describe("Post slug (URL handle). Either id OR slug is required."),
  response_format: ResponseFormatField,
}).strict();

const ListPagesInputSchema = PaginationSchema.extend({
  status: ContentStatusEnum.default("publish")
    .describe("Filter by status."),
  search: z.string().optional()
    .describe("Search term to match against title and content."),
  parent: z.number().int().min(0).optional()
    .describe("Filter to pages under this parent ID. Use 0 for top-level pages."),
  orderby: ContentOrderByEnum.default("menu_order")
    .describe("Field to sort by. Default 'menu_order' which respects the WP page hierarchy."),
  order: OrderEnum.default("asc")
    .describe("Sort direction."),
  response_format: ResponseFormatField,
}).strict();

const GetPageInputSchema = z.object({
  id: z.number().int().positive().optional()
    .describe("Numeric page ID. Either id OR slug is required."),
  slug: z.string().optional()
    .describe("Page slug (URL handle). Either id OR slug is required."),
  response_format: ResponseFormatField,
}).strict();

const SearchContentInputSchema = PaginationSchema.extend({
  query: z.string().min(2)
    .describe("Search string (minimum 2 characters)."),
  type: z.enum(["post", "page", "any"]).default("any")
    .describe("Restrict to posts, pages, or both."),
  response_format: ResponseFormatField,
}).strict();

type ListPostsInput = z.infer<typeof ListPostsInputSchema>;
type GetPostInput = z.infer<typeof GetPostInputSchema>;
type ListPagesInput = z.infer<typeof ListPagesInputSchema>;
type GetPageInput = z.infer<typeof GetPageInputSchema>;
type SearchContentInput = z.infer<typeof SearchContentInputSchema>;

// -----------------------------------------------------------------------------
// Write schemas (Phase 2)
// -----------------------------------------------------------------------------

// Fields shared between create and update operations for ALL content.
const ContentWriteSharedFields = {
  title: z.string().optional()
    .describe("Post/page title (plain text)."),
  content: z.string().optional()
    .describe("Post/page HTML content. Send <p>, <h2>, <a>, <img>, etc. WP renders inline."),
  excerpt: z.string().optional()
    .describe("Short summary shown on archive/listing pages."),
  slug: z.string().optional()
    .describe("URL slug. WP auto-generates from title if omitted on create."),
  status: ContentStatusEnum.optional()
    .describe("Status: publish | future | draft | pending | private. Default 'draft' on create."),
  author: z.number().int().positive().optional()
    .describe("Author user ID. Defaults to the authenticated user on create."),
  featured_media: z.number().int().min(0).optional()
    .describe("Featured image media ID. Use 0 to unset."),
  date: z.string().optional()
    .describe("Publish/schedule date in ISO 8601 (e.g. '2026-05-15T10:00:00'). For scheduling, also set status='future'."),
};

const PostOnlyWriteFields = {
  categories: z.array(z.number().int().positive()).optional()
    .describe("Category IDs to assign. Replaces existing on update."),
  tags: z.array(z.number().int().positive()).optional()
    .describe("Tag IDs to assign. Replaces existing on update."),
};

const PageOnlyWriteFields = {
  parent: z.number().int().min(0).optional()
    .describe("Parent page ID. Use 0 for top-level page."),
  menu_order: z.number().int().optional()
    .describe("Numeric position in the WP page hierarchy."),
};

const CreatePostInputSchema = z.object({
  ...ContentWriteSharedFields,
  ...PostOnlyWriteFields,
  status: ContentStatusEnum.default("draft")
    .describe("Status. Defaults to 'draft' for safety. Set to 'publish' to publish immediately."),
  response_format: ResponseFormatField,
}).strict();

const UpdatePostInputSchema = z.object({
  id: z.number().int().positive()
    .describe("Post ID to update."),
  ...ContentWriteSharedFields,
  ...PostOnlyWriteFields,
  content_path: z.string().optional()
    .describe("Absolute path to a local file (on the machine running this MCP) whose UTF-8 contents become the post 'content'. Use for bodies too large to pass inline. Overrides 'content' if both are given."),
  response_format: ResponseFormatField,
}).strict();

const DeletePostInputSchema = z.object({
  id: z.number().int().positive()
    .describe("Post ID to delete."),
  force: z.boolean().default(false)
    .describe("Default false (move to trash, recoverable). Set true to permanently delete."),
  response_format: ResponseFormatField,
}).strict();

const CreatePageInputSchema = z.object({
  ...ContentWriteSharedFields,
  ...PageOnlyWriteFields,
  status: ContentStatusEnum.default("draft")
    .describe("Status. Defaults to 'draft' for safety."),
  response_format: ResponseFormatField,
}).strict();

const UpdatePageInputSchema = z.object({
  id: z.number().int().positive()
    .describe("Page ID to update."),
  ...ContentWriteSharedFields,
  ...PageOnlyWriteFields,
  content_path: z.string().optional()
    .describe("Absolute path to a local file (on the machine running this MCP) whose UTF-8 contents become the page 'content'. Use for bodies too large to pass inline. Overrides 'content' if both are given."),
  response_format: ResponseFormatField,
}).strict();

const DeletePageInputSchema = z.object({
  id: z.number().int().positive()
    .describe("Page ID to delete."),
  force: z.boolean().default(false)
    .describe("Default false (move to trash, recoverable). Set true to permanently delete."),
  response_format: ResponseFormatField,
}).strict();

type CreatePostInput = z.infer<typeof CreatePostInputSchema>;
type UpdatePostInput = z.infer<typeof UpdatePostInputSchema>;
type DeletePostInput = z.infer<typeof DeletePostInputSchema>;
type CreatePageInput = z.infer<typeof CreatePageInputSchema>;
type UpdatePageInput = z.infer<typeof UpdatePageInputSchema>;
type DeletePageInput = z.infer<typeof DeletePageInputSchema>;

/**
 * Build the WP REST request body for a content write. Strips undefined fields
 * so they don't accidentally null out existing values on update.
 */
function buildContentPayload(input: Record<string, unknown>, isPost: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const allowed = isPost
    ? ["title", "content", "excerpt", "slug", "status", "author", "featured_media", "date", "categories", "tags"]
    : ["title", "content", "excerpt", "slug", "status", "author", "featured_media", "date", "parent", "menu_order"];
  for (const key of allowed) {
    if (input[key] !== undefined) payload[key] = input[key];
  }
  return payload;
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export function registerContentTools(server: McpServer): void {
  // -- wp_list_posts --
  server.registerTool(
    "wp_list_posts",
    {
      title: "List WordPress Posts",
      description: `List blog posts on arsnovasingers.org with filtering, pagination, and sorting.

Returns a paginated list of posts (default 20 per page). Posts are returned newest-first by default. Use status='any' to include drafts/pending/private (requires edit_posts capability).

Args:
  - limit (number): Page size, 1-100. Default 20.
  - offset (number): Pagination offset. Default 0.
  - status (enum): publish | future | draft | pending | private | trash | any. Default 'publish'.
  - search (string): Optional keyword to search title + content.
  - author (number): Optional author ID filter.
  - categories (number[]): Optional list of category IDs to filter to.
  - tags (number[]): Optional list of tag IDs to filter to.
  - orderby (enum): date | modified | id | title | slug | author | relevance. Default 'date'.
  - order (enum): asc | desc. Default 'desc'.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  Paginated envelope with shape:
  {
    "total": number,            // Total matching posts on the server
    "count": number,            // Posts in this response
    "offset": number,           // Pagination offset
    "items": [WPContentItem],   // Trimmed post shape (id, title, slug, status, link, excerpt, content_preview, author_id, etc.)
    "has_more": boolean,
    "next_offset": number       // Present if has_more
  }`,
      inputSchema: ListPostsInputSchema.shape,

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListPostsInput) => {
      try {
        const wpParams: Record<string, unknown> = {
          per_page: params.limit,
          offset: params.offset,
          status: params.status,
          orderby: params.orderby,
          order: params.order,
        };
        if (params.search) wpParams.search = params.search;
        if (params.author) wpParams.author = params.author;
        if (params.categories?.length) wpParams.categories = params.categories.join(",");
        if (params.tags?.length) wpParams.tags = params.tags.join(",");

        const result = await makeApiRequest<RawWpContent[]>(
          wpV2("posts"),
          "GET",
          wpParams
        );
        const items = result.data.map(transformContent);
        const envelope = enforceCharLimit(buildPaginated(items, result.total, params.offset));
        const text = renderResponse(envelope, params.response_format, "Posts", formatContentItemMarkdown);
        return toolResult(text, envelope);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_get_post --
  server.registerTool(
    "wp_get_post",
    {
      title: "Get WordPress Post",
      description: `Fetch a single blog post by ID or slug. Returns the full content of the post (rendered to plain text — HTML stripped).

At least one of 'id' or 'slug' must be provided.

Args:
  - id (number): Numeric post ID. Mutually exclusive with slug.
  - slug (string): URL handle of the post. Mutually exclusive with id.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  A single WPContentItem object with the full content_preview field expanded
  to up to 500 characters of plain-text content. For full content, the JSON
  response includes the original raw body.`,
      inputSchema: GetPostInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetPostInput) => {
      try {
        if (!params.id && !params.slug) {
          return toolError("Either 'id' or 'slug' must be provided.");
        }
        let raw: RawWpContent;
        if (params.id) {
          const result = await makeApiRequest<RawWpContent>(wpV2(`posts/${params.id}`));
          raw = result.data;
        } else {
          const result = await makeApiRequest<RawWpContent[]>(wpV2("posts"), "GET", {
            slug: params.slug,
            per_page: 1,
          });
          if (!result.data.length) {
            return toolError(`No post found with slug '${params.slug}'.`);
          }
          raw = result.data[0]!;
        }
        const item = transformContent(raw);
        // Replace content_preview with full content in single-item view.
        item.content_preview = stripHtml(raw.content?.rendered);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : formatContentItemMarkdown(item);
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_list_pages --
  server.registerTool(
    "wp_list_pages",
    {
      title: "List WordPress Pages",
      description: `List static pages on arsnovasingers.org. Pages differ from posts: they are hierarchical, ordered by menu_order rather than date, and used for evergreen content (About, Concerts, Education, Contact, etc.).

Args:
  - limit (number): Page size, 1-100. Default 20.
  - offset (number): Pagination offset. Default 0.
  - status (enum): publish | future | draft | pending | private | trash | any. Default 'publish'.
  - search (string): Optional keyword filter.
  - parent (number): Optional parent page ID filter. Use 0 for top-level pages.
  - orderby (enum): Default 'menu_order' (respects WP page tree).
  - order (enum): Default 'asc'.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  Paginated envelope (same shape as wp_list_posts) of WPContentItem objects.`,
      inputSchema: ListPagesInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListPagesInput) => {
      try {
        const wpParams: Record<string, unknown> = {
          per_page: params.limit,
          offset: params.offset,
          status: params.status,
          orderby: params.orderby,
          order: params.order,
        };
        if (params.search) wpParams.search = params.search;
        if (params.parent !== undefined) wpParams.parent = params.parent;

        const result = await makeApiRequest<RawWpContent[]>(wpV2("pages"), "GET", wpParams);
        const items = result.data.map(transformContent);
        const envelope = enforceCharLimit(buildPaginated(items, result.total, params.offset));
        const text = renderResponse(envelope, params.response_format, "Pages", formatContentItemMarkdown);
        return toolResult(text, envelope);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_get_page --
  server.registerTool(
    "wp_get_page",
    {
      title: "Get WordPress Page",
      description: `Fetch a single page by ID or slug. Returns the full content (rendered to plain text — HTML stripped).

At least one of 'id' or 'slug' must be provided.

Args:
  - id (number): Numeric page ID. Mutually exclusive with slug.
  - slug (string): URL handle of the page (e.g. "about", "concerts"). Mutually exclusive with id.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  A single WPContentItem object with full content_preview expanded.`,
      inputSchema: GetPageInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetPageInput) => {
      try {
        if (!params.id && !params.slug) {
          return toolError("Either 'id' or 'slug' must be provided.");
        }
        let raw: RawWpContent;
        if (params.id) {
          const result = await makeApiRequest<RawWpContent>(wpV2(`pages/${params.id}`));
          raw = result.data;
        } else {
          const result = await makeApiRequest<RawWpContent[]>(wpV2("pages"), "GET", {
            slug: params.slug,
            per_page: 1,
          });
          if (!result.data.length) {
            return toolError(`No page found with slug '${params.slug}'.`);
          }
          raw = result.data[0]!;
        }
        const item = transformContent(raw);
        item.content_preview = stripHtml(raw.content?.rendered);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : formatContentItemMarkdown(item);
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_search_content --
  server.registerTool(
    "wp_search_content",
    {
      title: "Search WordPress Content",
      description: `Cross-content keyword search across posts and pages using WP's built-in /wp/v2/search endpoint. Lighter-weight than wp_list_posts(search=...) because it returns just (id, title, url, type, subtype) per match.

Args:
  - query (string): Required, minimum 2 characters.
  - type (enum): post | page | any. Default 'any' (searches both).
  - limit (number): Page size, 1-100. Default 20.
  - offset (number): Pagination offset. Default 0.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  Paginated envelope of search hits with shape:
  {
    "total": number,
    "count": number,
    "offset": number,
    "items": [{ "id": number, "title": string, "url": string, "type": string, "subtype": string }],
    "has_more": boolean,
    "next_offset": number
  }`,
      inputSchema: SearchContentInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SearchContentInput) => {
      try {
        const wpParams: Record<string, unknown> = {
          search: params.query,
          per_page: params.limit,
          offset: params.offset,
        };
        if (params.type !== "any") wpParams.subtype = params.type;

        interface RawSearchHit {
          id: number;
          title: string;
          url: string;
          type: string;
          subtype: string;
        }
        const result = await makeApiRequest<RawSearchHit[]>(wpV2("search"), "GET", wpParams);
        const items = result.data.map((hit) => ({
          id: hit.id,
          title: stripHtml(hit.title),
          url: hit.url,
          type: hit.type,
          subtype: hit.subtype,
        }));
        const envelope = enforceCharLimit(buildPaginated(items, result.total, params.offset));
        const text = renderResponse(
          envelope,
          params.response_format,
          `Search results for '${params.query}'`,
          (hit) => `## ${hit.title} (${hit.subtype}, ID ${hit.id})\n- **URL**: ${hit.url}`
        );
        return toolResult(text, envelope);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Phase 2 — Write tools
  // ---------------------------------------------------------------------------

  // -- wp_create_post --
  server.registerTool(
    "wp_create_post",
    {
      title: "Create WordPress Post",
      description: `Create a new blog post. Defaults to status='draft' for safety — set status='publish' to publish immediately.

Args:
  - title (string): Post title.
  - content (string): HTML body.
  - excerpt (string): Optional short summary.
  - slug (string): URL slug. Auto-generated from title if omitted.
  - status (enum): publish | future | draft | pending | private. Default 'draft'.
  - author (number): Author user ID. Defaults to authenticated user.
  - featured_media (number): Featured image media ID.
  - date (string): ISO 8601 schedule date. Set status='future' for scheduling.
  - categories (number[]): Category IDs.
  - tags (number[]): Tag IDs.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  The created WPContentItem (id, slug, status, link, etc.)`,
      inputSchema: CreatePostInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: CreatePostInput) => {
      try {
        const payload = buildContentPayload(params as unknown as Record<string, unknown>, true);
        const result = await makeApiRequest<RawWpContent>(wpV2("posts"), "POST", undefined, payload);
        const item = transformContent(result.data);
        item.content_preview = stripHtml(result.data.content?.rendered);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : `# Created post (ID ${item.id})\n\n${formatContentItemMarkdown(item)}`;
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_update_post --
  server.registerTool(
    "wp_update_post",
    {
      title: "Update WordPress Post",
      description: `Update an existing post. Only the fields you pass will change; omitted fields preserve their current values.

Args:
  - id (number): Post ID to update. Required.
  - title, content, excerpt, slug, status, author, featured_media, date, categories, tags: all optional, same shape as wp_create_post.
  - content_path (string): Optional. Absolute local file path; its contents become the post content (for bodies too large to pass inline). Overrides 'content'.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  The updated WPContentItem.`,
      inputSchema: UpdatePostInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: UpdatePostInput) => {
      try {
        const { id, response_format, content_path, ...rest } = params;
        if (content_path) {
          try {
            (rest as Record<string, unknown>).content = readFileSync(content_path, "utf8");
          } catch (e) {
            return toolError(`Could not read content_path '${content_path}': ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const payload = buildContentPayload(rest as Record<string, unknown>, true);
        if (Object.keys(payload).length === 0) {
          return toolError("Pass at least one field to update (title, content, status, etc).");
        }
        const result = await makeApiRequest<RawWpContent>(wpV2(`posts/${id}`), "PUT", undefined, payload);
        const item = transformContent(result.data);
        item.content_preview = stripHtml(result.data.content?.rendered);
        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : `# Updated post (ID ${item.id})\n\nFields changed: ${Object.keys(payload).join(", ")}\n\n${formatContentItemMarkdown(item)}`;
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_delete_post --
  server.registerTool(
    "wp_delete_post",
    {
      title: "Delete WordPress Post",
      description: `Delete a post. Defaults to trash (recoverable for 30 days). Set force=true to permanently delete.

Args:
  - id (number): Post ID to delete. Required.
  - force (boolean): Default false. True = permanent delete (skip trash).
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  JSON with deletion outcome:
  - force=false: the post object with status='trash'
  - force=true: { deleted: true, previous: <full post object> }`,
      inputSchema: DeletePostInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: DeletePostInput) => {
      try {
        const result = await makeApiRequest<{ deleted?: boolean; previous?: RawWpContent } | RawWpContent>(
          wpV2(`posts/${params.id}`),
          "DELETE",
          { force: params.force }
        );
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(result.data, null, 2)
          : params.force
            ? `# Post ${params.id} permanently deleted.`
            : `# Post ${params.id} moved to trash. (Recoverable for 30 days via wp-admin > Posts > Trash.)`;
        return toolResult(text, result.data as object);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_create_page --
  server.registerTool(
    "wp_create_page",
    {
      title: "Create WordPress Page",
      description: `Create a new static page. Defaults to status='draft'.

Args:
  - title, content, excerpt, slug, status, author, featured_media, date: same as wp_create_post.
  - parent (number): Parent page ID. 0 for top-level.
  - menu_order (number): Numeric position in the page hierarchy.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  The created WPContentItem.`,
      inputSchema: CreatePageInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: CreatePageInput) => {
      try {
        const payload = buildContentPayload(params as unknown as Record<string, unknown>, false);
        const result = await makeApiRequest<RawWpContent>(wpV2("pages"), "POST", undefined, payload);
        const item = transformContent(result.data);
        item.content_preview = stripHtml(result.data.content?.rendered);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : `# Created page (ID ${item.id})\n\n${formatContentItemMarkdown(item)}`;
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_update_page --
  server.registerTool(
    "wp_update_page",
    {
      title: "Update WordPress Page",
      description: `Update an existing page. Only the fields you pass will change.

Args:
  - id (number): Page ID. Required.
  - All other fields optional, same shape as wp_create_page.
  - content_path (string): Optional. Absolute local file path; its contents become the page content (for bodies too large to pass inline). Overrides 'content'.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  The updated WPContentItem.`,
      inputSchema: UpdatePageInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: UpdatePageInput) => {
      try {
        const { id, response_format, content_path, ...rest } = params;
        if (content_path) {
          try {
            (rest as Record<string, unknown>).content = readFileSync(content_path, "utf8");
          } catch (e) {
            return toolError(`Could not read content_path '${content_path}': ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const payload = buildContentPayload(rest as Record<string, unknown>, false);
        if (Object.keys(payload).length === 0) {
          return toolError("Pass at least one field to update (title, content, status, etc).");
        }
        const result = await makeApiRequest<RawWpContent>(wpV2(`pages/${id}`), "PUT", undefined, payload);
        const item = transformContent(result.data);
        item.content_preview = stripHtml(result.data.content?.rendered);
        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : `# Updated page (ID ${item.id})\n\nFields changed: ${Object.keys(payload).join(", ")}\n\n${formatContentItemMarkdown(item)}`;
        return toolResult(text, item);
      } catch (error) {
  
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_delete_page --
  server.registerTool(
    "wp_delete_page",
    {
      title: "Delete WordPress Page",
      description: `Delete a page. Defaults to trash. Set force=true to permanently delete.

Args:
  - id (number): Page ID. Required.
  - force (boolean): Default false (trash). True = permanent.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  Deletion outcome (see wp_delete_post for shape).`,
      inputSchema: DeletePageInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: DeletePageInput) => {
      try {
        const result = await makeApiRequest<{ deleted?: boolean; previous?: RawWpContent } | RawWpContent>(
          wpV2(`pages/${params.id}`),
          "DELETE",
          { force: params.force }
        );
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(result.data, null, 2)
          : params.force
            ? `# Page ${params.id} permanently deleted.`
            : `# Page ${params.id} moved to trash. (Recoverable for 30 days via wp-admin > Pages > Trash.)`;
        return toolResult(text, result.data as object);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
