/**
 * Footer / widget / theme-source tools.
 *
 * - Widgets & sidebars use WordPress CORE REST (/wp/v2/sidebars, /wp/v2/widgets),
 *   available since WP 5.8 for block-based widgets. Requires admin
 *   (edit_theme_options). Used to read and populate Kadence footer widget areas.
 * - Theme-file reading uses the companion "Ars Nova Bridge" plugin
 *   (/ars-nova/v1/theme-file) to read theme source on the server, sandboxed to
 *   wp-content/themes. Lets us discover Kadence footer-builder option keys.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest, wpV2 } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

const EmptySchema = z.object({ response_format: ResponseFormatField }).strict();

const CreateWidgetSchema = z.object({
  sidebar: z.string().describe("Sidebar/widget-area ID to add the widget to (e.g. a Kadence footer area). Get IDs from wp_get_sidebars."),
  content: z.string().describe("Block markup for the widget body (e.g. '<!-- wp:heading -->...'). Creates a block-based widget."),
  response_format: ResponseFormatField,
}).strict();
type CreateWidgetInput = z.infer<typeof CreateWidgetSchema>;

const UpdateWidgetSchema = z.object({
  id: z.string().describe("Widget instance ID (e.g. 'block-5'). Get from wp_get_widgets."),
  sidebar: z.string().optional().describe("Move the widget to this sidebar ID. Use 'wp_inactive_widgets' to deactivate."),
  content: z.string().optional().describe("New block markup for the widget body."),
  response_format: ResponseFormatField,
}).strict();
type UpdateWidgetInput = z.infer<typeof UpdateWidgetSchema>;

const ReadThemeFileSchema = z.object({
  path: z.string().optional().describe("Path relative to wp-content/themes (e.g. 'kadence' or 'kadence/inc/customizer'). Omit to list the themes directory. Directory -> listing; file -> contents."),
  response_format: ResponseFormatField,
}).strict();
type ReadThemeFileInput = z.infer<typeof ReadThemeFileSchema>;

export function registerFooterTools(server: McpServer): void {
  server.registerTool(
    "wp_get_sidebars",
    {
      title: "List Widget Areas (Sidebars)",
      description: `List all registered widget areas / sidebars (incl. Kadence footer areas) with their IDs and the widgets currently in each. Core REST /wp/v2/sidebars. Requires admin.\n\nReturns: array of { id, name, status, widgets[] }.`,
      inputSchema: EmptySchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const r = await makeApiRequest<unknown[]>(wpV2("sidebars"), "GET");
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : (Array.isArray(r.data) ? r.data : [])
              .map((s) => {
                const o = s as Record<string, unknown>;
                const widgets = Array.isArray(o.widgets) ? o.widgets.length : 0;
                return `- **${o.id}** — ${o.name} (${widgets} widget(s), status: ${o.status})`;
              })
              .join("\n");
        return toolResult(text, { sidebars: r.data });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "wp_get_widgets",
    {
      title: "List Widgets",
      description: `List all widget instances across sidebars, with their IDs, sidebar assignment, and rendered/raw content. Core REST /wp/v2/widgets. Requires admin.`,
      inputSchema: EmptySchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const r = await makeApiRequest<unknown[]>(wpV2("widgets"), "GET");
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : (Array.isArray(r.data) ? r.data : [])
              .map((w) => {
                const o = w as Record<string, unknown>;
                return `- **${o.id}** (sidebar: ${o.sidebar}, type: ${o.id_base})`;
              })
              .join("\n");
        return toolResult(text, { widgets: r.data });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "wp_create_widget",
    {
      title: "Create Widget (block)",
      description: `Create a block-based widget in a sidebar/widget area. Use for populating Kadence footer columns. Requires admin.\n\nArgs:\n  - sidebar (string): target widget-area ID (from wp_get_sidebars).\n  - content (string): block markup for the widget body.\n\nReturns: the created widget (incl. its new id).`,
      inputSchema: CreateWidgetSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params: CreateWidgetInput) => {
      try {
        const body = {
          id_base: "block",
          sidebar: params.sidebar,
          instance: { raw: { content: params.content } },
        };
        const r = await makeApiRequest<Record<string, unknown>>(wpV2("widgets"), "POST", undefined, body);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : `# Widget created\n\n- id: ${r.data.id}\n- sidebar: ${r.data.sidebar}`;
        return toolResult(text, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "wp_update_widget",
    {
      title: "Update / Move Widget",
      description: `Update a widget's content and/or move it to another sidebar (use sidebar 'wp_inactive_widgets' to deactivate). Core REST PUT /wp/v2/widgets/{id}. Requires admin.`,
      inputSchema: UpdateWidgetSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params: UpdateWidgetInput) => {
      try {
        const body: Record<string, unknown> = {};
        if (params.sidebar !== undefined) body.sidebar = params.sidebar;
        if (params.content !== undefined) body.instance = { raw: { content: params.content } };
        if (Object.keys(body).length === 0) {
          return toolError("Nothing to update. Pass 'sidebar' and/or 'content'.");
        }
        const r = await makeApiRequest<Record<string, unknown>>(wpV2(`widgets/${params.id}`), "PUT", undefined, body);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : `# Widget updated\n\n- id: ${r.data.id}\n- sidebar: ${r.data.sidebar}`;
        return toolResult(text, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "wp_read_theme_file",
    {
      title: "Read Theme Source File",
      description: `Read theme source on the server (sandboxed to wp-content/themes) via the Ars Nova Bridge plugin. Directory path -> listing; file path -> contents (cap 500 KB). Use to discover Kadence footer-builder option keys. Requires Bridge plugin active + admin.\n\nArgs:\n  - path (string): relative to wp-content/themes (e.g. 'kadence/inc'). Omit to list themes.`,
      inputSchema: ReadThemeFileSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: ReadThemeFileInput) => {
      try {
        const r = await makeApiRequest<Record<string, unknown>>(
          "ars-nova/v1/theme-file",
          "GET",
          params.path ? { path: params.path } : undefined
        );
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : r.data.type === "dir"
            ? `# ${r.data.path || "themes"} (dir)\n\n` +
              (Array.isArray(r.data.entries) ? r.data.entries : [])
                .map((e) => {
                  const o = e as Record<string, unknown>;
                  return `- ${o.type === "dir" ? "📁" : "📄"} ${o.name}${o.size ? ` (${o.size}b)` : ""}`;
                })
                .join("\n")
            : `# ${r.data.path} (${r.data.size}b)\n\n\`\`\`\n${r.data.contents}\n\`\`\``;
        return toolResult(text, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
