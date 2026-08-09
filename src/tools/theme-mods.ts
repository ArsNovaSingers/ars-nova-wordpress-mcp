/**
 * Theme-mods read/write tools.
 *
 * Drives Kadence / Customizer settings, which WordPress stores as `theme_mods`
 * (a per-theme serialized option that core does NOT expose over the standard
 * REST API). These tools call the companion "Ars Nova Bridge" plugin, which
 * registers admin-only routes under /ars-nova/v1/theme-mods.
 *
 * Requires: the Ars Nova Bridge plugin active on the target site + an admin
 * Application Password (edit_theme_options capability).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

/** Custom REST route exposed by the Ars Nova Bridge plugin (under /wp-json). */
const BRIDGE_ROUTE = "ars-nova/v1/theme-mods";

interface ThemeModsResponse {
  theme?: string;
  theme_name?: string;
  count?: number;
  mods?: Record<string, unknown>;
  ok?: boolean;
  changed?: Record<string, unknown>;
  removed?: string[];
}

const GetThemeModsSchema = z.object({
  keys: z.array(z.string()).optional()
    .describe("Optional list of theme_mod keys to return. Omit to return ALL mods."),
  response_format: ResponseFormatField,
}).strict();
type GetThemeModsInput = z.infer<typeof GetThemeModsSchema>;

const SetThemeModsSchema = z.object({
  mods: z.record(z.any()).optional()
    .describe("Object of theme_mod key:value pairs to set. Values may be string, number, boolean, array, or object."),
  remove: z.array(z.string()).optional()
    .describe("List of theme_mod keys to remove (reset to the theme's default)."),
  response_format: ResponseFormatField,
}).strict();
type SetThemeModsInput = z.infer<typeof SetThemeModsSchema>;

export function registerThemeModsTools(server: McpServer): void {
  server.registerTool(
    "wp_get_theme_mods",
    {
      title: "Get Theme Mods (Kadence/Customizer)",
      description: `Read the active theme's theme_mods — the storage behind Kadence/Customizer settings (header layout, logo, colors, fonts, page-title display, etc.). Core REST does not expose these; this uses the companion "Ars Nova Bridge" plugin (must be active).

Args:
  - keys (string[]): optional filter to specific theme_mod keys.
  - response_format (enum): markdown | json.

Returns: active theme slug/name and the theme_mods map.`,
      inputSchema: GetThemeModsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: GetThemeModsInput) => {
      try {
        const r = await makeApiRequest<ThemeModsResponse>(BRIDGE_ROUTE, "GET");
        let mods: Record<string, unknown> = r.data.mods ?? {};
        if (params.keys && params.keys.length) {
          const filtered: Record<string, unknown> = {};
          for (const k of params.keys) {
            if (k in mods) filtered[k] = mods[k];
          }
          mods = filtered;
        }
        const payload = {
          theme: r.data.theme,
          theme_name: r.data.theme_name,
          count: Object.keys(mods).length,
          mods,
        };
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(payload, null, 2)
          : `# Theme mods — ${r.data.theme_name ?? r.data.theme ?? "active theme"}\n\n` +
            `${Object.keys(mods).length} key(s)\n\n` +
            Object.entries(mods)
              .map(([k, v]) => `- **${k}**: ${typeof v === "string" ? v : JSON.stringify(v)}`)
              .join("\n");
        return toolResult(text, payload);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "wp_set_theme_mods",
    {
      title: "Set Theme Mods (Kadence/Customizer)",
      description: `Set and/or remove the active theme's theme_mods — drives Kadence/Customizer settings by command. Uses the companion "Ars Nova Bridge" plugin (must be active). Requires admin.

CAUTION: theme_mods control header/layout/colors. ALWAYS read current values with wp_get_theme_mods and back them up before bulk changes. Removing a key resets it to the theme default.

Args:
  - mods (object): key:value pairs to set. Values may be string/number/bool/array/object.
  - remove (string[]): keys to reset to default.
  - response_format (enum): markdown | json.

Returns: what changed/removed plus the full updated theme_mods map.`,
      inputSchema: SetThemeModsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (params: SetThemeModsInput) => {
      try {
        const body: Record<string, unknown> = {};
        if (params.mods && Object.keys(params.mods).length) body.mods = params.mods;
        if (params.remove && params.remove.length) body.remove = params.remove;
        if (Object.keys(body).length === 0) {
          return toolError("Nothing to change. Pass 'mods' (key:value object) and/or 'remove' (array of keys).");
        }
        const r = await makeApiRequest<ThemeModsResponse>(BRIDGE_ROUTE, "POST", undefined, body);
        const changedKeys = Object.keys(r.data.changed ?? {});
        const removedKeys = r.data.removed ?? [];
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : `# Theme mods updated\n\n` +
            (changedKeys.length ? `Set: ${changedKeys.join(", ")}\n` : "") +
            (removedKeys.length ? `Removed: ${removedKeys.join(", ")}\n` : "") +
            `\nActive theme now has ${Object.keys(r.data.mods ?? {}).length} mod key(s).`;
        return toolResult(text, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
