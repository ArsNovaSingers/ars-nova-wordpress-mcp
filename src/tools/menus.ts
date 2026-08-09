/**
 * Menu tools — manage WordPress navigation menus and their items via the core
 * REST endpoints (/wp/v2/menus and /wp/v2/menu-items, available in WP 5.9+).
 *
 * These endpoints require the edit_theme_options capability (admin). The error
 * mapper in services/wp-client.ts surfaces clear next steps on 401/403.
 *
 * The headline tool is wp_build_menu: it creates a whole menu — including nested
 * submenus, ordering, and theme-location assignment — from a single structured
 * spec, so an entire navigation menu can be (re)built with one command.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest, wpV2 } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

// -----------------------------------------------------------------------------
// Helpers + raw shapes
// -----------------------------------------------------------------------------

function rendered(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "rendered" in (v as Record<string, unknown>)) {
    const r = (v as { rendered?: unknown }).rendered;
    if (typeof r === "string") return r;
  }
  return "";
}

interface RawMenu {
  id: number;
  name: string;
  slug: string;
  description?: string;
  locations?: string[];
}

interface RawMenuItem {
  id: number;
  title: { rendered?: string; raw?: string } | string;
  status: string;
  url?: string;
  type?: string; // post_type | taxonomy | custom | post_type_archive
  object?: string; // page | post | category | custom ...
  object_id?: number;
  parent?: number;
  menu_order?: number;
  menus?: number;
}

// -----------------------------------------------------------------------------
// Input schemas
// -----------------------------------------------------------------------------

const ListMenusSchema = z.object({
  response_format: ResponseFormatField,
}).strict();
type ListMenusInput = z.infer<typeof ListMenusSchema>;

const ListMenuItemsSchema = z.object({
  menu_id: z.number().int().describe("The menu ID whose items to list (from wp_list_menus)."),
  response_format: ResponseFormatField,
}).strict();
type ListMenuItemsInput = z.infer<typeof ListMenuItemsSchema>;

const CreateMenuSchema = z.object({
  name: z.string().describe("Menu name, e.g. 'Primary Navigation'."),
  locations: z.array(z.string()).optional()
    .describe("Theme menu locations to assign, e.g. ['primary']. Must be locations the active theme registers."),
  response_format: ResponseFormatField,
}).strict();
type CreateMenuInput = z.infer<typeof CreateMenuSchema>;

const UpdateMenuSchema = z.object({
  menu_id: z.number().int().describe("Menu ID to update."),
  name: z.string().optional().describe("New menu name."),
  locations: z.array(z.string()).optional().describe("Replace the menu's theme-location assignments."),
  response_format: ResponseFormatField,
}).strict();
type UpdateMenuInput = z.infer<typeof UpdateMenuSchema>;

const DeleteMenuSchema = z.object({
  menu_id: z.number().int().describe("Menu ID to delete."),
  response_format: ResponseFormatField,
}).strict();
type DeleteMenuInput = z.infer<typeof DeleteMenuSchema>;

const CreateMenuItemSchema = z.object({
  menu_id: z.number().int().describe("Menu this item belongs to."),
  title: z.string().describe("Label shown in the menu."),
  page_id: z.number().int().optional().describe("Link to this page ID (sets type=post_type, object=page)."),
  url: z.string().optional().describe("Custom URL (use instead of page_id for external/custom links)."),
  parent: z.number().int().default(0).describe("Parent menu-item ID for submenu nesting. 0 = top level."),
  menu_order: z.number().int().default(1).describe("Position within its level (ascending)."),
  response_format: ResponseFormatField,
}).strict();
type CreateMenuItemInput = z.infer<typeof CreateMenuItemSchema>;

const DeleteMenuItemSchema = z.object({
  item_id: z.number().int().describe("Menu-item ID to delete."),
  response_format: ResponseFormatField,
}).strict();
type DeleteMenuItemInput = z.infer<typeof DeleteMenuItemSchema>;

const UpdateMenuItemSchema = z.object({
  item_id: z.number().int().describe("Menu-item ID to update (from wp_list_menu_items)."),
  title: z.string().optional().describe("New label shown in the menu."),
  page_id: z.number().int().optional().describe("Repoint at this page ID (sets type=post_type, object=page). Mutually exclusive with url."),
  url: z.string().optional().describe("Repoint at this custom URL (sets type=custom). Mutually exclusive with page_id."),
  parent: z.number().int().optional().describe("New parent menu-item ID for submenu nesting. 0 = top level."),
  menu_order: z.number().int().optional().describe("New position within its level (ascending)."),
  target: z.enum(["", "_blank"]).optional().describe("Link target: '_blank' opens in a new tab, '' opens in the same tab."),
  description: z.string().optional().describe("Menu-item description (rendered by some themes)."),
  attr_title: z.string().optional().describe("HTML title attribute for the link."),
  classes: z.array(z.string()).optional().describe("CSS classes applied to the menu item."),
  response_format: ResponseFormatField,
}).strict();
type UpdateMenuItemInput = z.infer<typeof UpdateMenuItemSchema>;

// Recursive spec for wp_build_menu.
interface MenuItemSpecT {
  title: string;
  page_id?: number;
  url?: string;
  children?: MenuItemSpecT[];
}
const MenuItemSpec: z.ZodType<MenuItemSpecT> = z.lazy(() =>
  z.object({
    title: z.string().describe("Label shown in the menu."),
    page_id: z.number().int().optional().describe("Link to this page ID (post_type=page)."),
    url: z.string().optional().describe("Custom URL. Use instead of page_id for external/custom links. Omit both for a non-linking dropdown parent."),
    children: z.array(MenuItemSpec).optional().describe("Submenu items nested under this one."),
  })
);

const BuildMenuSchema = z.object({
  name: z.string().describe("Menu name to create, e.g. 'Primary Navigation'."),
  locations: z.array(z.string()).optional()
    .describe("Theme menu locations to assign, e.g. ['primary']."),
  items: z.array(MenuItemSpec).describe("Ordered top-level items, each optionally with nested children (submenus)."),
  response_format: ResponseFormatField,
}).strict();
type BuildMenuInput = z.infer<typeof BuildMenuSchema>;

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

function formatMenuLine(m: RawMenu): string {
  const loc = m.locations && m.locations.length ? ` — locations: ${m.locations.join(", ")}` : "";
  return `- **${m.name}** (id ${m.id}, slug ${m.slug})${loc}`;
}

function formatItemLine(it: RawMenuItem): string {
  const label = rendered(it.title);
  const target = it.object === "page" && it.object_id ? `page ${it.object_id}` : (it.url || it.type || "");
  const indent = it.parent && it.parent !== 0 ? "    " : "- ";
  return `${indent}${label} [${it.id}] → ${target} (order ${it.menu_order ?? 0}${it.parent ? `, parent ${it.parent}` : ""})`;
}

function buildItemBody(spec: { title: string; page_id?: number; url?: string }, menuId: number, parent: number, order: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: spec.title,
    status: "publish",
    menus: menuId,
    parent,
    menu_order: order,
  };
  if (spec.page_id !== undefined) {
    body.type = "post_type";
    body.object = "page";
    body.object_id = spec.page_id;
  } else if (spec.url !== undefined) {
    body.type = "custom";
    body.url = spec.url;
  } else {
    // Non-linking dropdown parent.
    body.type = "custom";
    body.url = "#";
  }
  return body;
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export function registerMenuTools(server: McpServer): void {
  // -- wp_list_menus --
  server.registerTool(
    "wp_list_menus",
    {
      title: "List Navigation Menus",
      description: `List all WordPress navigation menus with their IDs, slugs, and assigned theme locations. Requires admin (edit_theme_options).

Args:
  - response_format (enum): markdown | json. Default 'markdown'.

Returns: { count, items: [{ id, name, slug, locations }] }`,
      inputSchema: ListMenusSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: ListMenusInput) => {
      try {
        const r = await makeApiRequest<RawMenu[]>(wpV2("menus"), "GET", { per_page: 100 });
        const items = r.data;
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify({ count: items.length, items }, null, 2)
          : `# Navigation Menus (${items.length})\n\n${items.map(formatMenuLine).join("\n")}`;
        return toolResult(text, { count: items.length, items });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_list_menu_items --
  server.registerTool(
    "wp_list_menu_items",
    {
      title: "List Menu Items",
      description: `List the items in a navigation menu, in order, including nesting (parent IDs). Use the menu_id from wp_list_menus.

Args:
  - menu_id (number): The menu ID.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns: { count, items: [{ id, title, type, object, object_id, url, parent, menu_order }] }`,
      inputSchema: ListMenuItemsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: ListMenuItemsInput) => {
      try {
        const r = await makeApiRequest<RawMenuItem[]>(wpV2("menu-items"), "GET", {
          menus: params.menu_id,
          per_page: 100,
          orderby: "menu_order",
          order: "asc",
        });
        const items = r.data;
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify({ count: items.length, items }, null, 2)
          : `# Menu Items (${items.length})\n\n${items.map(formatItemLine).join("\n")}`;
        return toolResult(text, { count: items.length, items });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_create_menu --
  server.registerTool(
    "wp_create_menu",
    {
      title: "Create Navigation Menu",
      description: `Create an empty navigation menu, optionally assigning it to theme locations (e.g. ['primary']). Returns the new menu ID. Requires admin.

Args:
  - name (string): Menu name.
  - locations (string[]): Optional theme locations to assign.
  - response_format (enum): markdown | json.`,
      inputSchema: CreateMenuSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: CreateMenuInput) => {
      try {
        const body: Record<string, unknown> = { name: params.name };
        if (params.locations) body.locations = params.locations;
        const r = await makeApiRequest<RawMenu>(wpV2("menus"), "POST", undefined, body);
        return toolResult(`Created menu "${r.data.name}" (id ${r.data.id}).`, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_update_menu --
  server.registerTool(
    "wp_update_menu",
    {
      title: "Update Navigation Menu",
      description: `Rename a menu and/or change its theme-location assignments. Requires admin.

Args:
  - menu_id (number): Menu to update.
  - name (string): Optional new name.
  - locations (string[]): Optional new location list (replaces existing).
  - response_format (enum): markdown | json.`,
      inputSchema: UpdateMenuSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: UpdateMenuInput) => {
      try {
        const body: Record<string, unknown> = {};
        if (params.name !== undefined) body.name = params.name;
        if (params.locations !== undefined) body.locations = params.locations;
        const r = await makeApiRequest<RawMenu>(wpV2(`menus/${params.menu_id}`), "POST", undefined, body);
        return toolResult(`Updated menu "${r.data.name}" (id ${r.data.id}).`, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_delete_menu --
  server.registerTool(
    "wp_delete_menu",
    {
      title: "Delete Navigation Menu",
      description: `Permanently delete a navigation menu and all its items (force delete). Requires admin. This cannot be undone via the API.

Args:
  - menu_id (number): Menu to delete.
  - response_format (enum): markdown | json.`,
      inputSchema: DeleteMenuSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params: DeleteMenuInput) => {
      try {
        await makeApiRequest<unknown>(wpV2(`menus/${params.menu_id}`), "DELETE", { force: true });
        return toolResult(`Deleted menu id ${params.menu_id}.`);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_create_menu_item --
  server.registerTool(
    "wp_create_menu_item",
    {
      title: "Add Menu Item",
      description: `Add a single item to a menu. Link it to a page (page_id) or to a custom URL (url). Nest it by setting parent to another item's ID. Requires admin.

Args:
  - menu_id (number): Menu to add to.
  - title (string): Label.
  - page_id (number): Link to this page ID (or use url).
  - url (string): Custom URL (or use page_id).
  - parent (number): Parent item ID for nesting. 0 = top level.
  - menu_order (number): Position within its level.
  - response_format (enum): markdown | json.`,
      inputSchema: CreateMenuItemSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: CreateMenuItemInput) => {
      try {
        const body = buildItemBody(params, params.menu_id, params.parent, params.menu_order);
        const r = await makeApiRequest<RawMenuItem>(wpV2("menu-items"), "POST", undefined, body);
        return toolResult(`Added "${rendered(r.data.title)}" (item ${r.data.id}) to menu ${params.menu_id}.`, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_update_menu_item --
  server.registerTool(
    "wp_update_menu_item",
    {
      title: "Update Menu Item",
      description: `Update a single existing menu item IN PLACE — rename it, repoint it, re-nest it, or reorder it — without rebuilding the menu. Only the fields you pass are changed. Requires admin.

Prefer this over wp_build_menu for small edits. Rebuilding a menu regenerates EVERY item ID, which breaks anything referencing them and leaves orphaned rows behind; this changes one row.

Args:
  - item_id (number): Menu-item ID to update (from wp_list_menu_items). Required.
  - title (string): New label.
  - page_id (number): Repoint at this page ID. Mutually exclusive with url.
  - url (string): Repoint at this custom URL. Mutually exclusive with page_id.
  - parent (number): New parent item ID. 0 = top level.
  - menu_order (number): New position within its level.
  - target (enum): '' (same tab) | '_blank' (new tab).
  - description (string), attr_title (string), classes (string[]).
  - response_format (enum): markdown | json.

Returns: the updated menu item.`,
      inputSchema: UpdateMenuItemSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: UpdateMenuItemInput) => {
      try {
        if (params.page_id !== undefined && params.url !== undefined) {
          return toolError(
            "Pass either page_id or url, not both — they set conflicting link targets."
          );
        }

        const body: Record<string, unknown> = {};
        if (params.title !== undefined) body.title = params.title;
        if (params.parent !== undefined) body.parent = params.parent;
        if (params.menu_order !== undefined) body.menu_order = params.menu_order;
        if (params.target !== undefined) body.target = params.target;
        if (params.description !== undefined) body.description = params.description;
        if (params.attr_title !== undefined) body.attr_title = params.attr_title;
        if (params.classes !== undefined) body.classes = params.classes;
        if (params.page_id !== undefined) {
          body.type = "post_type";
          body.object = "page";
          body.object_id = params.page_id;
        } else if (params.url !== undefined) {
          body.type = "custom";
          body.object = "custom";
          body.url = params.url;
        }

        if (Object.keys(body).length === 0) {
          return toolError(
            "Nothing to update — pass at least one field besides item_id."
          );
        }

        const r = await makeApiRequest<RawMenuItem>(
          wpV2(`menu-items/${params.item_id}`),
          "POST",
          undefined,
          body
        );
        const changed = Object.keys(body).join(", ");
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : `Updated menu item ${params.item_id} ("${rendered(r.data.title)}"). Changed: ${changed}.`;
        return toolResult(text, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_delete_menu_item --
  server.registerTool(
    "wp_delete_menu_item",
    {
      title: "Delete Menu Item",
      description: `Permanently remove a single menu item (force delete). Requires admin.

Args:
  - item_id (number): Menu-item ID to remove.
  - response_format (enum): markdown | json.`,
      inputSchema: DeleteMenuItemSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (params: DeleteMenuItemInput) => {
      try {
        await makeApiRequest<unknown>(wpV2(`menu-items/${params.item_id}`), "DELETE", { force: true });
        return toolResult(`Deleted menu item ${params.item_id}.`);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_build_menu (the headline tool) --
  server.registerTool(
    "wp_build_menu",
    {
      title: "Build a Whole Menu in One Command",
      description: `Create an entire navigation menu — nested submenus, ordering, and theme-location assignment — from one structured spec. Ideal for rebuilding a site's primary navigation by command.

Each item links to a page (page_id) OR a custom URL (url), OR neither (a non-linking dropdown parent that just holds children). Children create submenus. Order follows array order.

Args:
  - name (string): Menu name to create.
  - locations (string[]): Optional theme locations, e.g. ['primary'].
  - items: ordered array of { title, page_id?, url?, children?[] }.
  - response_format (enum): markdown | json.

Example items:
[
  { "title": "Concerts", "children": [
      { "title": "This Season", "page_id": 123 },
      { "title": "Tickets", "page_id": 3285 }
  ]},
  { "title": "Donate", "url": "/support/donate/" }
]

Returns: { menu_id, items_created, locations }. Note: creates a NEW menu; it does not merge into an existing one. Use wp_list_menus / wp_delete_menu first if replacing.`,
      inputSchema: BuildMenuSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: BuildMenuInput) => {
      try {
        // 1. Create the menu shell.
        const menuBody: Record<string, unknown> = { name: params.name };
        if (params.locations) menuBody.locations = params.locations;
        const menuRes = await makeApiRequest<RawMenu>(wpV2("menus"), "POST", undefined, menuBody);
        const menuId = menuRes.data.id;

        // 2. Recursively create items, capturing parent IDs before children.
        let created = 0;
        const createItem = async (spec: MenuItemSpecT, parentId: number, order: number): Promise<void> => {
          const body = buildItemBody(spec, menuId, parentId, order);
          const itemRes = await makeApiRequest<RawMenuItem>(wpV2("menu-items"), "POST", undefined, body);
          created++;
          const newId = itemRes.data.id;
          if (spec.children && spec.children.length) {
            let j = 1;
            for (const child of spec.children) {
              await createItem(child, newId, j);
              j++;
            }
          }
        };

        let i = 1;
        for (const top of params.items) {
          await createItem(top, 0, i);
          i++;
        }

        const locText = params.locations && params.locations.length
          ? `, assigned to location(s): ${params.locations.join(", ")}`
          : "";
        const summary = `Built menu "${params.name}" (id ${menuId}) with ${created} item(s)${locText}.`;
        return toolResult(summary, { menu_id: menuId, items_created: created, locations: params.locations ?? [] });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
