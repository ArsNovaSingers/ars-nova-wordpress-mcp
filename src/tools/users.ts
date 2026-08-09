/**
 * User tools — list and inspect WP users (admin-only endpoints in most cases).
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
import { ResponseFormat, type WPUserItem } from "../types.js";

interface RawWpUser {
  id: number;
  name: string;
  slug: string;
  url: string;
  description: string;
  link: string;
  roles?: string[];
  capabilities?: Record<string, boolean>;
  registered_date?: string;
}

function transformUser(raw: RawWpUser): WPUserItem {
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    url: raw.url,
    description: stripHtml(raw.description),
    link: raw.link,
    ...(raw.roles ? { roles: raw.roles } : {}),
    ...(raw.capabilities ? { capabilities: raw.capabilities } : {}),
    ...(raw.registered_date ? { registered_date: raw.registered_date } : {}),
  };
}

function formatUserMarkdown(item: WPUserItem): string {
  const lines = [
    `## ${item.name} (ID ${item.id})`,
    `- **Slug**: ${item.slug}`,
    `- **Profile URL**: ${item.link}`,
  ];
  if (item.roles?.length) lines.push(`- **Roles**: ${item.roles.join(", ")}`);
  if (item.registered_date) lines.push(`- **Registered**: ${item.registered_date}`);
  if (item.url) lines.push(`- **Personal URL**: ${item.url}`);
  if (item.description) lines.push(`- **Bio**: ${item.description}`);
  return lines.join("\n");
}

const ListUsersInputSchema = PaginationSchema.extend({
  search: z.string().optional()
    .describe("Search term to match against username, email, name."),
  roles: z.array(z.string()).optional()
    .describe("Filter to users in any of these roles (e.g. ['administrator', 'editor'])."),
  orderby: z.enum(["id", "name", "registered_date", "slug", "include"]).default("name")
    .describe("Sort field."),
  order: OrderEnum.default("asc")
    .describe("Sort direction."),
  context: z.enum(["view", "embed", "edit"]).default("view")
    .describe("WP REST context. 'edit' returns roles/capabilities/email but requires list_users capability."),
  response_format: ResponseFormatField,
}).strict();

const GetUserInputSchema = z.object({
  id: z.number().int().positive()
    .describe("Numeric user ID."),
  context: z.enum(["view", "embed", "edit"]).default("view")
    .describe("WP REST context. 'edit' returns roles/capabilities/email but requires list_users capability."),
  response_format: ResponseFormatField,
}).strict();

type ListUsersInput = z.infer<typeof ListUsersInputSchema>;
type GetUserInput = z.infer<typeof GetUserInputSchema>;

// -----------------------------------------------------------------------------
// Write schemas (Phase 2)
// -----------------------------------------------------------------------------

const UpdateUserInputSchema = z.object({
  id: z.number().int().positive()
    .describe("User ID to update."),
  name: z.string().optional()
    .describe("Display name."),
  email: z.string().email().optional()
    .describe("Email address."),
  first_name: z.string().optional()
    .describe("First name."),
  last_name: z.string().optional()
    .describe("Last name."),
  roles: z.array(z.string()).optional()
    .describe("Roles to assign (e.g. ['editor'] or ['subscriber']). Replaces existing roles."),
  url: z.string().optional()
    .describe("Personal website URL."),
  description: z.string().optional()
    .describe("Bio."),
  slug: z.string().optional()
    .describe("URL slug for author archive."),
  response_format: ResponseFormatField,
}).strict();

const DeleteUserInputSchema = z.object({
  id: z.number().int().positive()
    .describe("User ID to delete."),
  reassign: z.number().int().positive()
    .describe("REQUIRED: User ID to reassign the deleted user's content (posts, etc.) to. WP REST does not allow deleting a user without a reassignment target."),
  response_format: ResponseFormatField,
}).strict();

type UpdateUserInput = z.infer<typeof UpdateUserInputSchema>;
type DeleteUserInput = z.infer<typeof DeleteUserInputSchema>;

export function registerUserTools(server: McpServer): void {
  server.registerTool(
    "wp_list_users",
    {
      title: "List WordPress Users",
      description: `List users on the WP site. Use context='edit' to see roles/capabilities (requires admin).

Args:
  - limit (number): Page size, 1-100. Default 20.
  - offset (number): Pagination offset.
  - search (string): Optional keyword filter (matches username, email, name).
  - roles (string[]): Optional filter to users in these roles.
  - orderby (enum): id | name | registered_date | slug | include. Default 'name'.
  - order (enum): asc | desc. Default 'asc'.
  - context (enum): view | embed | edit. Default 'view'. Use 'edit' to get roles/capabilities.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  Paginated envelope of WPUserItem objects with shape:
  { id, name, slug, url, description, link, roles?, capabilities?, registered_date? }`,
      inputSchema: ListUsersInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListUsersInput) => {
      try {
        const wpParams: Record<string, unknown> = {
          per_page: params.limit,
          offset: params.offset,
          orderby: params.orderby,
          order: params.order,
          context: params.context,
        };
        if (params.search) wpParams.search = params.search;
        if (params.roles?.length) wpParams.roles = params.roles.join(",");

        const result = await makeApiRequest<RawWpUser[]>(wpV2("users"), "GET", wpParams);
        const items = result.data.map(transformUser);
        const envelope = enforceCharLimit(buildPaginated(items, result.total, params.offset));
        const text = renderResponse(envelope, params.response_format, "Users", formatUserMarkdown);
        return toolResult(text, envelope);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "wp_get_user",
    {
      title: "Get WordPress User",
      description: `Fetch a single user by ID. Use context='edit' to get roles/capabilities (requires admin).

Args:
  - id (number): Numeric user ID.
  - context (enum): view | embed | edit. Default 'view'.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  A single WPUserItem object.`,
      inputSchema: GetUserInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetUserInput) => {
      try {
        const result = await makeApiRequest<RawWpUser>(wpV2(`users/${params.id}`), "GET", {
          context: params.context,
        });
        const item = transformUser(result.data);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : formatUserMarkdown(item);
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Phase 2 — Write tools
  // ---------------------------------------------------------------------------

  // -- wp_update_user --
  server.registerTool(
    "wp_update_user",
    {
      title: "Update WordPress User",
      description: `Update an existing user's name, email, roles, or profile fields. Common use: demoting an admin to editor or subscriber.

Args:
  - id (number): User ID. Required.
  - name, email, first_name, last_name, url, description, slug: optional fields to update.
  - roles (string[]): Replaces existing roles. e.g. ['editor'], ['subscriber'], ['administrator'].
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  The updated WPUserItem.`,
      inputSchema: UpdateUserInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: UpdateUserInput) => {
      try {
        const { id, response_format, ...rest } = params;
        const payload: Record<string, unknown> = {};
        for (const key of ["name", "email", "first_name", "last_name", "roles", "url", "description", "slug"] as const) {
          if ((rest as Record<string, unknown>)[key] !== undefined) {
            payload[key] = (rest as Record<string, unknown>)[key];
          }
        }
        if (Object.keys(payload).length === 0) {
          return toolError("Pass at least one field to update (name, email, roles, etc.).");
        }
        const result = await makeApiRequest<RawWpUser>(wpV2(`users/${id}`), "PUT", undefined, payload);
        const item = transformUser(result.data);
        const text = response_format === ResponseFormat.JSON
          ? JSON.stringify(item, null, 2)
          : `# Updated user (ID ${item.id})\n\nFields changed: ${Object.keys(payload).join(", ")}\n\n${formatUserMarkdown(item)}`;
        return toolResult(text, item);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_delete_user --
  server.registerTool(
    "wp_delete_user",
    {
      title: "Delete WordPress User",
      description: `Permanently delete a user. WP requires a reassign target — the deleted user's content (posts, pages, media) gets transferred to that user ID. WP REST does NOT support trashing users; deletion is always permanent.

Args:
  - id (number): User ID to delete. Required.
  - reassign (number): User ID to receive the deleted user's content. Required.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  { deleted: true, previous: <full user object> }`,
      inputSchema: DeleteUserInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: DeleteUserInput) => {
      try {
        const result = await makeApiRequest<{ deleted?: boolean; previous?: RawWpUser }>(
          wpV2(`users/${params.id}`),
          "DELETE",
          { force: true, reassign: params.reassign }
        );
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(result.data, null, 2)
          : `# User ${params.id} permanently deleted. Content reassigned to user ${params.reassign}.`;
        return toolResult(text, result.data as object);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
