/**
 * ACF Options tools — read and write Stagehand's global content stored in
 * ACF Pro Options pages.
 *
 * Requires the "ACF to REST API" plugin (airesvsg) to be installed and active
 * on the target site. That plugin registers /wp-json/acf/v3/options/(id)
 * endpoints with GET/POST/PUT/PATCH methods.
 *
 * Stagehand on arsnovasingers.org stores footer/header/alert-bar/sponsor
 * content in the default "options" page. Known top-level fields include:
 *   - column_copy_1, column_copy_2, column_copy_3  (footer column HTML)
 *   - column_header_1, column_header_2, column_header_3  (footer column titles)
 *   - footer_sponsors (repeater of sponsor logo/link items)
 *   - alert_bar (repeater of dated banner items)
 *   - accessible_hero / accessible_hero_style (hero accessibility flags)
 *
 * For other Options pages exposed by the theme/plugins, pass the page slug
 * as `option_page`. The default is "options".
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

// -----------------------------------------------------------------------------
// Endpoint helper — ACF to REST API uses its own namespace
// -----------------------------------------------------------------------------

function acfOptionsPath(optionPage: string, field?: string): string {
  const safePage = optionPage.replace(/[^a-zA-Z0-9_-]/g, "");
  const base = `acf/v3/options/${safePage || "options"}`;
  if (field) {
    const safeField = field.replace(/[^a-zA-Z0-9_-]/g, "");
    return `${base}/${safeField}`;
  }
  return base;
}

// -----------------------------------------------------------------------------
// wp_get_acf_options — read all fields, or a single field
// -----------------------------------------------------------------------------

const GetAcfOptionsInputSchema = z.object({
  option_page: z.string()
    .default("options")
    .describe("ACF Options page slug. Default 'options' (Stagehand's global Options page). Other examples: 'general-options'. Only [a-zA-Z0-9_-] allowed."),
  field: z.string()
    .optional()
    .describe("Optional specific field name to return (e.g. 'column_copy_2'). If omitted, returns the entire acf object."),
  response_format: ResponseFormatField,
}).strict();
type GetAcfOptionsInput = z.infer<typeof GetAcfOptionsInputSchema>;

interface AcfReadResponse {
  acf?: unknown;
}

function renderAcfMarkdown(data: AcfReadResponse, field?: string): string {
  const acf = data?.acf;
  if (acf === undefined || acf === null) {
    return `# ACF Options\n\n_No data returned. Confirm 'ACF to REST API' plugin is active and the options page slug is correct._`;
  }
  if (field) {
    if (acf && typeof acf === "object" && !Array.isArray(acf) && field in (acf as Record<string, unknown>)) {
      const value = (acf as Record<string, unknown>)[field];
      return `# ACF Field: ${field}\n\n\`\`\`\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n\`\`\``;
    }
    return `# ACF Field: ${field}\n\n\`\`\`\n${typeof acf === "string" ? acf : JSON.stringify(acf, null, 2)}\n\`\`\``;
  }
  if (acf && typeof acf === "object" && !Array.isArray(acf)) {
    const entries = Object.entries(acf as Record<string, unknown>);
    if (entries.length === 0) {
      return `# ACF Options\n\n_No fields returned (empty object). The options page may not have the 'show_in_rest' flag enabled, or no fields are populated._`;
    }
    const lines = entries.map(([k, v]) => {
      let preview: string;
      if (v === null || v === undefined) {
        preview = "_(empty)_";
      } else if (Array.isArray(v)) {
        preview = `_list, ${v.length} item(s)_`;
      } else if (typeof v === "object") {
        preview = `_object, ${Object.keys(v as object).length} key(s)_`;
      } else {
        const s = String(v);
        preview = s.length > 120 ? s.slice(0, 117) + "..." : s;
      }
      return `- **${k}**: ${preview}`;
    });
    return `# ACF Options (${entries.length} fields)\n\n${lines.join("\n")}\n\n_Use 'field' param or 'response_format: json' to inspect full values._`;
  }
  return `# ACF Options\n\n\`\`\`\n${JSON.stringify(acf, null, 2)}\n\`\`\``;
}

// -----------------------------------------------------------------------------
// wp_update_acf_options — write one or more fields
// -----------------------------------------------------------------------------

const UpdateAcfOptionsInputSchema = z.object({
  option_page: z.string()
    .default("options")
    .describe("ACF Options page slug. Default 'options'. Only [a-zA-Z0-9_-] allowed."),
  fields: z.record(z.string(), z.unknown())
    .describe("Object of field_name -> new_value pairs. Values can be strings (HTML for WYSIWYG/text fields), numbers, booleans, arrays (for repeaters), or nested objects (for groups). Only the fields you include are changed; omitted fields are untouched. Example: { \"column_copy_2\": \"<p><a href='/x'>X</a></p>\" }"),
  response_format: ResponseFormatField,
}).strict();
type UpdateAcfOptionsInput = z.infer<typeof UpdateAcfOptionsInputSchema>;

interface AcfWriteResponse {
  acf?: unknown;
  // ACF to REST API returns various shapes depending on version; treat loosely.
  [key: string]: unknown;
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export function registerAcfTools(server: McpServer): void {
  // -- wp_get_acf_options --
  server.registerTool(
    "wp_get_acf_options",
    {
      title: "Get ACF Options Page Fields",
      description: `Read fields from an ACF (Advanced Custom Fields) Options page on arsnovasingers.org.

Requires the "ACF to REST API" plugin (airesvsg) to be installed and active. Reads from /wp-json/acf/v3/options/{option_page}.

Use this for Stagehand's global site content — footer columns/headers, alert bars, sponsor blocks, etc. — that aren't stored on a specific page.

Args:
  - option_page (string): Options page slug. Default 'options' (Stagehand's main Options page).
  - field (string, optional): Specific field name to return. If omitted, returns all fields.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  WPACFOptionsResult { acf: { [field_name]: value, ... } }`,
      inputSchema: GetAcfOptionsInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetAcfOptionsInput) => {
      try {
        const path = acfOptionsPath(params.option_page, params.field);
        const result = await makeApiRequest<AcfReadResponse>(path);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(result.data, null, 2)
          : renderAcfMarkdown(result.data, params.field);
        return toolResult(text, result.data as Record<string, unknown>);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_update_acf_options --
  server.registerTool(
    "wp_update_acf_options",
    {
      title: "Update ACF Options Page Fields",
      description: `Write one or more fields to an ACF Options page on arsnovasingers.org.

Requires the "ACF to REST API" plugin (airesvsg) to be installed and active. Posts to /wp-json/acf/v3/options/{option_page} with body { fields: {...} }.

ONLY the field names you include in 'fields' are modified — omitted fields are untouched. This is safe for incremental edits to the footer, alert bar, etc., without needing to re-send the entire Options page.

For repeater fields (e.g. footer_sponsors, alert_bar), you must send the COMPLETE new array — repeaters are replaced wholesale, not merged. Read first with wp_get_acf_options to get the current array, modify it locally, then send back.

Args:
  - option_page (string): Options page slug. Default 'options'.
  - fields (object): { field_name: new_value, ... }. Values: strings (HTML for WYSIWYG, plain text), numbers, booleans, arrays (full replacement for repeaters), or nested objects (for groups).
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  Result of the write including the updated fields and any plugin-returned metadata.`,
      inputSchema: UpdateAcfOptionsInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: UpdateAcfOptionsInput) => {
      try {
        const path = acfOptionsPath(params.option_page);
        const body = { fields: params.fields };
        const result = await makeApiRequest<AcfWriteResponse>(path, "POST", undefined, body);

        const fieldNames = Object.keys(params.fields);
        const summary = `# ACF Options Updated\n\n- **Options page**: \`${params.option_page}\`\n- **Fields written**: ${fieldNames.length} (${fieldNames.map(n => `\`${n}\``).join(", ")})\n- **HTTP status**: ${result.status}\n\nVerify with wp_get_acf_options if needed. Clear WPEngine Page + Network cache so the changes propagate.`;

        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(result.data, null, 2)
          : summary;
        return toolResult(text, result.data as Record<string, unknown>);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
