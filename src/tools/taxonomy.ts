/**
 * Taxonomy tools — list categories and tags.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest, wpV2 } from "../services/wp-client.js";
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
import { ResponseFormat, type WPTermItem } from "../types.js";

interface RawWpTerm {
  id: number;
  name: string;
  slug: string;
  description: string;
  count: number;
  parent: number;
  link: string;
}

function transformTerm(raw: RawWpTerm): WPTermItem {
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    description: stripHtml(raw.description),
    count: raw.count,
    parent: raw.parent,
    link: raw.link,
  };
}

function formatTermMarkdown(item: WPTermItem): string {
  const lines = [
    `## ${item.name} (ID ${item.id})`,
    `- **Slug**: ${item.slug}`,
    `- **Post count**: ${item.count}`,
    `- **Archive URL**: ${item.link}`,
  ];
  if (item.parent > 0) lines.push(`- **Parent ID**: ${item.parent}`);
  if (item.description) lines.push(`- **Description**: ${item.description}`);
  return lines.join("\n");
}

const ListTermsInputSchema = PaginationSchema.extend({
  search: z.string().optional()
    .describe("Search term to match against name."),
  hide_empty: z.boolean().default(false)
    .describe("If true, hide terms with no associated content."),
  orderby: z.enum(["id", "name", "slug", "count", "include"]).default("name")
    .describe("Sort field."),
  order: OrderEnum.default("asc")
    .describe("Sort direction."),
  parent: z.number().int().min(0).optional()
    .describe("Filter to terms under this parent ID. Use 0 for top-level."),
  response_format: ResponseFormatField,
}).strict();

type ListTermsInput = z.infer<typeof ListTermsInputSchema>;

async function listTermsImpl(taxonomy: "categories" | "tags", params: ListTermsInput) {
  try {
    const wpParams: Record<string, unknown> = {
      per_page: params.limit,
      offset: params.offset,
      orderby: params.orderby,
      order: params.order,
      hide_empty: params.hide_empty,
    };
    if (params.search) wpParams.search = params.search;
    if (params.parent !== undefined) wpParams.parent = params.parent;

    const result = await makeApiRequest<RawWpTerm[]>(wpV2(taxonomy), "GET", wpParams);
    const items = result.data.map(transformTerm);
    const envelope = enforceCharLimit(buildPaginated(items, result.total, params.offset));
    const title = taxonomy === "categories" ? "Categories" : "Tags";
    const text = renderResponse(envelope, params.response_format, title, formatTermMarkdown);
    return toolResult(text, envelope);
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

// -----------------------------------------------------------------------------
// Write schemas (Phase 2)
// -----------------------------------------------------------------------------

const CreateCategoryInputSchema = z.object({
  name: z.string().min(1)
    .describe("Category name (display)."),
  slug: z.string().optional()
    .describe("URL slug. Auto-generated from name if omitted."),
  description: z.string().optional()
    .describe("Description shown on category archive pages."),
  parent: z.number().int().min(0).optional()
    .describe("Parent category ID. 0 for top-level."),
  response_format: ResponseFormatField,
}).strict();

const UpdateCategoryInputSchema = z.object({
  id: z.number().int().positive()
    .describe("Category ID to update."),
  name: z.string().optional()
    .describe("New name."),
  slug: z.string().optional()
    .describe("New slug."),
  description: z.string().optional()
    .describe("New description."),
  parent: z.number().int().min(0).optional()
    .describe("New parent ID."),
  response_format: ResponseFormatField,
}).strict();

const CreateTagInputSchema = z.object({
  name: z.string().min(1)
    .describe("Tag name (display)."),
  slug: z.string().optional()
    .describe("URL slug. Auto-generated from name if omitted."),
  description: z.string().optional()
    .describe("Description shown on tag archive pages."),
  response_format: ResponseFormatField,
}).strict();

const UpdateTagInputSchema = z.object({
  id: z.number().int().positive()
    .describe("Tag ID to update."),
  name: z.string().optional()
    .describe("New name."),
  slug: z.string().optional()
    .describe("New slug."),
  description: z.string().optional()
    .describe("New description."),
  response_format: ResponseFormatField,
}).strict();

type CreateCategoryInput = z.infer<typeof CreateCategoryInputSchema>;
type UpdateCategoryInput = z.infer<typeof UpdateCategoryInputSchema>;
type CreateTagInput = z.infer<typeof CreateTagInputSchema>;
type UpdateTagInput = z.infer<typeof UpdateTagInputSchema>;

export function registerTaxonomyTools(server: McpServer): void {
  server.registerTool(
    "wp_list_categories",
    {
      title: "List WordPress Categories",
      description: `List post categories with hierarchy + post counts.

Args:
  - limit (number): Page size, 1-100. Default 20.
  - offset (number): Pagination offset.
  - search (string): Optional keyword filter.
  - hide_empty (boolean): Default false. Set true to skip categories with no posts.
  - orderby (enum): id | name | slug | count | include. Default 'name'.
  - order (enum): asc | desc. Default 'asc'.
  - parent (number): Optional parent category ID filter. Use 0 for top-level.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  Paginated envelope of WPTermItem objects with shape:
  { id, name, slug, description, count, parent, link }`,
      inputSchema: ListTermsInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListTermsInput) => listTermsImpl("categories", params)
  );

  server.registerTool(
    "wp_list_tags",
    {
      title: "List WordPress Tags",
      description: `List post tags with post counts.

Args:
  - limit (number): Page size, 1-100. Default 20.
  - offset (number): Pagination offset.
  - search (string): Optional keyword filter.
  - hide_empty (boolean): Default false.
  - orderby (enum): id | name | slug | count | include. Default 'name'.
  - order (enum): asc | desc. Default 'asc'.
  - parent (number): Tags do not have hierarchy on most sites; this is usually ignored.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  Paginated envelope of WPTermItem objects.`,
      inputSchema: ListTermsInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListTermsInput) => listTermsImpl("tags", params)
  );

  // ---------------------------------------------------------------------------
  // Phase 2 — Write tools
  // ---------------------------------------------------------------------------

  // -- wp_create_category --
  server.registerTool(
    "wp_create_category",
    {
      title: "Create WordPress Category",
      description: `Create a new post category.

Args:
  - name (string): Required. Display name.
  - slug (string): Optional. Auto-generated from name if omitted.
  - description (string): Optional.
  - parent (number): Optional parent category ID. 0 for top-level.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  The created WPTermItem.`,
      inputSchema: CreateCategoryInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: CreateCategoryInput) => {
      try {
        const { response_format, ...rest } = params;
        const payload: Record<string, unknown> = {};
        for (const key of ["name", "slug", "description", "parent"] as const) {
          if ((rest as Record<string, unknown>)[key] !== undefined) {
            payload[key] = (rest as Record<string, unknown>)[key];
          }
        }
        const result = await makeApiRequest<RawWpTerm>(wpV2("categories"), "POST", undefined, payload);
        const item = transformTerm(result.data);
        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : `# Created category (ID ${item.id})\n\n${formatTermMarkdown(item)}`;
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_update_category --
  server.registerTool(
    "wp_update_category",
    {
      title: "Update WordPress Category",
      description: `Update an existing category's name, slug, description, or parent.

Args:
  - id (number): Category ID. Required.
  - name, slug, description (string): Optional.
  - parent (number): New parent category ID.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  The updated WPTermItem.`,
      inputSchema: UpdateCategoryInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: UpdateCategoryInput) => {
      try {
        const { id, response_format, ...rest } = params;
        const payload: Record<string, unknown> = {};
        for (const key of ["name", "slug", "description", "parent"] as const) {
          if ((rest as Record<string, unknown>)[key] !== undefined) {
            payload[key] = (rest as Record<string, unknown>)[key];
          }
        }
        if (Object.keys(payload).length === 0) {
          return toolError("Pass at least one field to update (name, slug, description, parent).");
        }
        const result = await makeApiRequest<RawWpTerm>(wpV2(`categories/${id}`), "PUT", undefined, payload);
        const item = transformTerm(result.data);
        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : `# Updated category (ID ${item.id})\n\nFields changed: ${Object.keys(payload).join(", ")}\n\n${formatTermMarkdown(item)}`;
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_create_tag --
  server.registerTool(
    "wp_create_tag",
    {
      title: "Create WordPress Tag",
      description: `Create a new post tag.

Args:
  - name (string): Required. Display name.
  - slug (string): Optional. Auto-generated from name if omitted.
  - description (string): Optional.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  The created WPTermItem.`,
      inputSchema: CreateTagInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: CreateTagInput) => {
      try {
        const { response_format, ...rest } = params;
        const payload: Record<string, unknown> = {};
        for (const key of ["name", "slug", "description"] as const) {
          if ((rest as Record<string, unknown>)[key] !== undefined) {
            payload[key] = (rest as Record<string, unknown>)[key];
          }
        }
        const result = await makeApiRequest<RawWpTerm>(wpV2("tags"), "POST", undefined, payload);
        const item = transformTerm(result.data);
        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : `# Created tag (ID ${item.id})\n\n${formatTermMarkdown(item)}`;
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_update_tag --
  server.registerTool(
    "wp_update_tag",
    {
      title: "Update WordPress Tag",
      description: `Update an existing tag's name, slug, or description.

Args:
  - id (number): Tag ID. Required.
  - name, slug, description (string): Optional.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  The updated WPTermItem.`,
      inputSchema: UpdateTagInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: UpdateTagInput) => {
      try {
        const { id, response_format, ...rest } = params;
        const payload: Record<string, unknown> = {};
        for (const key of ["name", "slug", "description"] as const) {
          if ((rest as Record<string, unknown>)[key] !== undefined) {
            payload[key] = (rest as Record<string, unknown>)[key];
          }
        }
        if (Object.keys(payload).length === 0) {
          return toolError("Pass at least one field to update (name, slug, description).");
        }
        const result = await makeApiRequest<RawWpTerm>(wpV2(`tags/${id}`), "PUT", undefined, payload);
        const item = transformTerm(result.data);
        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : `# Updated tag (ID ${item.id})\n\nFields changed: ${Object.keys(payload).join(", ")}\n\n${formatTermMarkdown(item)}`;
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
