/**
 * Site tools — high-level site info, themes, plugins, settings, post types.
 *
 * Most of these endpoints are admin-only. They will return 401/403 if the
 * Application Password belongs to a non-admin user. The error mapper in
 * services/wp-client.ts surfaces clear next steps in that case.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getSiteUrl, makeApiRequest, wpV2 } from "../services/wp-client.js";
import {
  stripHtml,
  toolError,
  toolResult,
} from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import {
  ResponseFormat,
  type WPPluginItem,
  type WPSiteInfo,
  type WPThemeItem,
} from "../types.js";
import { ENV_LABEL } from "../constants.js";

// -----------------------------------------------------------------------------
// wp_get_site_info — combines /wp-json (root) + /wp/v2/settings (admin)
// -----------------------------------------------------------------------------

const GetSiteInfoInputSchema = z.object({
  response_format: ResponseFormatField,
}).strict();
type GetSiteInfoInput = z.infer<typeof GetSiteInfoInputSchema>;

interface RawWpRoot {
  name?: string;
  description?: string;
  url?: string;
  home?: string;
  gmt_offset?: string;
  timezone_string?: string;
  namespaces?: string[];
  authentication?: Record<string, unknown>;
}

interface RawWpSettings {
  title?: string;
  description?: string;
  url?: string;
  email?: string;
  timezone?: string;
  date_format?: string;
  time_format?: string;
  start_of_week?: number;
  language?: string;
  use_smilies?: boolean;
  default_category?: number;
  default_post_format?: string;
  posts_per_page?: number;
  show_on_front?: string;
  page_on_front?: number;
  page_for_posts?: number;
  default_ping_status?: string;
  default_comment_status?: string;
}

function formatSiteInfoMarkdown(info: WPSiteInfo): string {
  const lines = [
    `# Site Info`,
    "",
    `- **Site URL**: ${info.site_url}`,
  ];
  if (info.title) lines.push(`- **Title**: ${info.title}`);
  if (info.description) lines.push(`- **Tagline**: ${info.description}`);
  if (info.email) lines.push(`- **Admin email**: ${info.email}`);
  if (info.timezone) lines.push(`- **Timezone**: ${info.timezone}`);
  if (info.language) lines.push(`- **Language**: ${info.language}`);
  if (info.posts_per_page !== undefined) lines.push(`- **Posts per page**: ${info.posts_per_page}`);
  if (info.show_on_front) lines.push(`- **Front page mode**: ${info.show_on_front}` +
    (info.show_on_front === "page" && info.page_on_front ? ` (page ID ${info.page_on_front})` : ""));
  if (info.default_category) lines.push(`- **Default category ID**: ${info.default_category}`);
  lines.push("");
  lines.push(`## REST API namespaces (${info.api_namespaces.length})`);
  lines.push(info.api_namespaces.map((ns) => `- ${ns}`).join("\n"));
  if (info.api_authentication.length) {
    lines.push("");
    lines.push(`## Supported authentication methods`);
    lines.push(info.api_authentication.map((m) => `- ${m}`).join("\n"));
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// wp_list_themes
// -----------------------------------------------------------------------------

const ListThemesInputSchema = z.object({
  status: z.enum(["active", "inactive", "any"]).default("any")
    .describe("Filter by status."),
  response_format: ResponseFormatField,
}).strict();
type ListThemesInput = z.infer<typeof ListThemesInputSchema>;

interface RawWpTheme {
  stylesheet: string;
  template: string;
  status: string;
  name?: { rendered?: string } | string;
  version: string;
  author?: { rendered?: string } | string;
  author_uri?: { rendered?: string } | string;
  description?: { rendered?: string } | string;
  theme_uri?: { rendered?: string } | string;
  requires_wp?: string;
  requires_php?: string;
  tags?: { rendered?: string[] } | string[];
  textdomain?: string;
  screenshot?: string;
}

function renderedOrString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "rendered" in (v as Record<string, unknown>)) {
    const r = (v as { rendered?: unknown }).rendered;
    if (typeof r === "string") return r;
  }
  return "";
}

function renderedTags(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (v && typeof v === "object" && "rendered" in (v as Record<string, unknown>)) {
    const r = (v as { rendered?: unknown }).rendered;
    if (Array.isArray(r)) return r as string[];
  }
  return [];
}

function transformTheme(raw: RawWpTheme): WPThemeItem {
  return {
    stylesheet: raw.stylesheet,
    template: raw.template,
    name: stripHtml(renderedOrString(raw.name)),
    status: raw.status,
    version: raw.version,
    author: stripHtml(renderedOrString(raw.author)),
    author_uri: renderedOrString(raw.author_uri),
    description: stripHtml(renderedOrString(raw.description)),
    theme_uri: renderedOrString(raw.theme_uri),
    is_child_theme: raw.template !== raw.stylesheet,
    requires_wp: raw.requires_wp || "",
    requires_php: raw.requires_php || "",
    tags: renderedTags(raw.tags),
    textdomain: raw.textdomain || "",
    ...(raw.screenshot ? { screenshot: raw.screenshot } : {}),
  };
}

function formatThemeMarkdown(item: WPThemeItem): string {
  const lines = [
    `## ${item.name} ${item.status === "active" ? "**[ACTIVE]**" : ""}`.trim(),
    `- **Stylesheet**: ${item.stylesheet}`,
    `- **Version**: ${item.version}`,
    `- **Author**: ${item.author}`,
  ];
  if (item.is_child_theme) lines.push(`- **Child theme of**: ${item.template}`);
  if (item.requires_wp) lines.push(`- **Requires WP**: ${item.requires_wp}`);
  if (item.requires_php) lines.push(`- **Requires PHP**: ${item.requires_php}`);
  if (item.theme_uri) lines.push(`- **Theme URI**: ${item.theme_uri}`);
  if (item.description) lines.push(`- **Description**: ${item.description}`);
  if (item.tags.length) lines.push(`- **Tags**: ${item.tags.join(", ")}`);
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// wp_list_plugins
// -----------------------------------------------------------------------------

const ListPluginsInputSchema = z.object({
  status: z.enum(["active", "inactive", "any"]).default("any")
    .describe("Filter by status."),
  search: z.string().optional()
    .describe("Optional keyword filter against plugin name/description."),
  response_format: ResponseFormatField,
}).strict();
type ListPluginsInput = z.infer<typeof ListPluginsInputSchema>;

interface RawWpPlugin {
  plugin: string;
  status: string;
  name?: string;
  plugin_uri?: string;
  author?: string;
  author_uri?: string;
  description?: { rendered?: string; raw?: string } | string;
  version?: string;
  network_only?: boolean;
  requires_wp?: string;
  requires_php?: string;
  textdomain?: string;
}

function transformPlugin(raw: RawWpPlugin): WPPluginItem {
  return {
    plugin: raw.plugin,
    status: raw.status,
    name: stripHtml(raw.name || ""),
    plugin_uri: raw.plugin_uri || "",
    author: stripHtml(raw.author || ""),
    version: raw.version || "",
    description: stripHtml(renderedOrString(raw.description)),
    network_only: !!raw.network_only,
    requires_wp: raw.requires_wp || "",
    requires_php: raw.requires_php || "",
    textdomain: raw.textdomain || "",
  };
}

function formatPluginMarkdown(item: WPPluginItem): string {
  const lines = [
    `## ${item.name} ${item.status === "active" ? "**[ACTIVE]**" : ""}`.trim(),
    `- **Slug**: ${item.plugin}`,
    `- **Version**: ${item.version}`,
    `- **Author**: ${item.author}`,
  ];
  if (item.requires_wp) lines.push(`- **Requires WP**: ${item.requires_wp}`);
  if (item.requires_php) lines.push(`- **Requires PHP**: ${item.requires_php}`);
  if (item.plugin_uri) lines.push(`- **Plugin URI**: ${item.plugin_uri}`);
  if (item.description) lines.push(`- **Description**: ${item.description}`);
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// wp_get_settings — passthrough of /wp/v2/settings
// -----------------------------------------------------------------------------

const GetSettingsInputSchema = z.object({
  response_format: ResponseFormatField,
}).strict();
type GetSettingsInput = z.infer<typeof GetSettingsInputSchema>;

// -----------------------------------------------------------------------------
// wp_list_post_types
// -----------------------------------------------------------------------------

const ListPostTypesInputSchema = z.object({
  context: z.enum(["view", "edit"]).default("view")
    .describe("WP REST context. 'edit' returns supports/capabilities (admin only)."),
  response_format: ResponseFormatField,
}).strict();
type ListPostTypesInput = z.infer<typeof ListPostTypesInputSchema>;

interface RawWpPostType {
  description: string;
  hierarchical: boolean;
  has_archive: boolean | string;
  name: string;
  slug: string;
  rest_base: string;
  rest_namespace?: string;
  taxonomies?: string[];
  visibility?: { show_ui?: boolean; show_in_nav_menus?: boolean };
  supports?: Record<string, boolean>;
}

function formatPostTypeMarkdown(name: string, raw: RawWpPostType): string {
  const lines = [
    `## ${raw.name} (slug: ${raw.slug})`,
    `- **REST base**: ${raw.rest_base}`,
    `- **Hierarchical**: ${raw.hierarchical}`,
    `- **Has archive**: ${raw.has_archive}`,
  ];
  if (raw.rest_namespace) lines.push(`- **REST namespace**: ${raw.rest_namespace}`);
  if (raw.taxonomies?.length) lines.push(`- **Taxonomies**: ${raw.taxonomies.join(", ")}`);
  if (raw.description) lines.push(`- **Description**: ${raw.description}`);
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export function registerSiteTools(server: McpServer): void {
  // -- wp_check_environment --
  // SAFETY TOOL: Call this before any write operation to confirm which site you're on.
  server.registerTool(
    "wp_check_environment",
    {
      title: "Check WordPress Environment",
      description: `⚠️ SAFETY CHECK — Call this before any write, update, or delete operation.
Returns the site URL and environment label so you can confirm you are on the correct site
(LIVE vs DEV) before making changes. Never skip this on write operations.`,
      inputSchema: {},
    },
    async () => {
      const siteUrl = getSiteUrl();
      const label = ENV_LABEL;
      const isLive = !siteUrl.includes("kinsta.cloud") && !siteUrl.includes("staging") && !siteUrl.includes("dev");
      const warning = isLive
        ? "🔴 THIS IS THE LIVE PRODUCTION SITE. Changes are immediately public."
        : "🟢 This is a dev/staging site. Safe to experiment.";
      return toolResult(`Environment Check\n=================\nLabel:   ${label}\nURL:     ${siteUrl}\nStatus:  ${warning}`);
    }
  );

  // -- wp_get_site_info --
  server.registerTool(
    "wp_get_site_info",
    {
      title: "Get WordPress Site Info",
      description: `Get high-level info about the WordPress site: name, tagline, admin email, REST API namespaces, supported authentication, plus general WP settings.

Combines /wp-json (root, public) with /wp/v2/settings (admin-only). Settings fields will be omitted gracefully if your user lacks the manage_options capability.

Args:
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  WPSiteInfo object with shape:
  {
    "site_url": string,
    "api_namespaces": string[],
    "api_authentication": string[],
    "title"?: string, "description"?: string, "url"?: string, "email"?: string,
    "timezone"?: string, "language"?: string, "posts_per_page"?: number,
    "show_on_front"?: "posts" | "page", "page_on_front"?: number, "page_for_posts"?: number,
    "default_category"?: number, "default_post_format"?: string
  }`,
      inputSchema: GetSiteInfoInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetSiteInfoInput) => {
      try {
        // Root /wp-json — always public.
        const root = await makeApiRequest<RawWpRoot>("");
        // Settings — admin-only. Catch and proceed without if forbidden.
        let settings: RawWpSettings | undefined;
        try {
          const s = await makeApiRequest<RawWpSettings>(wpV2("settings"));
          settings = s.data;
        } catch (_e) {
          // swallow — surface as missing fields
        }

        const info: WPSiteInfo = {
          site_url: getSiteUrl(),
          api_namespaces: root.data.namespaces || [],
          api_authentication: root.data.authentication ? Object.keys(root.data.authentication) : [],
          ...(settings?.title !== undefined ? { title: settings.title } : {}),
          ...(settings?.description !== undefined ? { description: settings.description } : {}),
          ...(settings?.url !== undefined ? { url: settings.url } : {}),
          ...(settings?.email !== undefined ? { email: settings.email } : {}),
          ...(settings?.timezone !== undefined ? { timezone: settings.timezone } : {}),
          ...(settings?.date_format !== undefined ? { date_format: settings.date_format } : {}),
          ...(settings?.time_format !== undefined ? { time_format: settings.time_format } : {}),
          ...(settings?.start_of_week !== undefined ? { start_of_week: settings.start_of_week } : {}),
          ...(settings?.language !== undefined ? { language: settings.language } : {}),
          ...(settings?.use_smilies !== undefined ? { use_smilies: settings.use_smilies } : {}),
          ...(settings?.default_category !== undefined ? { default_category: settings.default_category } : {}),
          ...(settings?.default_post_format !== undefined ? { default_post_format: settings.default_post_format } : {}),
          ...(settings?.posts_per_page !== undefined ? { posts_per_page: settings.posts_per_page } : {}),
          ...(settings?.show_on_front !== undefined ? { show_on_front: settings.show_on_front } : {}),
          ...(settings?.page_on_front !== undefined ? { page_on_front: settings.page_on_front } : {}),
          ...(settings?.page_for_posts !== undefined ? { page_for_posts: settings.page_for_posts } : {}),
          ...(settings?.default_ping_status !== undefined ? { default_ping_status: settings.default_ping_status } : {}),
          ...(settings?.default_comment_status !== undefined ? { default_comment_status: settings.default_comment_status } : {}),
        };

        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(info, null, 2)
          : formatSiteInfoMarkdown(info);
        return toolResult(text, info);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_list_themes --
  server.registerTool(
    "wp_list_themes",
    {
      title: "List WordPress Themes",
      description: `List installed themes. The active theme is flagged with status='active'. Child themes are detected (template != stylesheet).

Note: This endpoint requires admin (edit_themes capability). Will return 403 if the Application Password user is not an admin.

Args:
  - status (enum): active | inactive | any. Default 'any'.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  Array of WPThemeItem objects with shape:
  { stylesheet, template, name, status, version, author, author_uri, description, theme_uri, is_child_theme, requires_wp, requires_php, tags, textdomain, screenshot? }`,
      inputSchema: ListThemesInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListThemesInput) => {
      try {
        const wpParams: Record<string, unknown> = {};
        if (params.status !== "any") wpParams.status = params.status;

        const result = await makeApiRequest<RawWpTheme[]>(wpV2("themes"), "GET", wpParams);
        const items = result.data.map(transformTheme);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify({ count: items.length, items }, null, 2)
          : `# Themes (${items.length})\n\n${items.map(formatThemeMarkdown).join("\n\n")}`;
        return toolResult(text, { count: items.length, items });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_list_plugins --
  server.registerTool(
    "wp_list_plugins",
    {
      title: "List WordPress Plugins",
      description: `List installed plugins with version, status, and metadata. The active plugins are flagged with status='active'.

Note: This endpoint requires admin (activate_plugins capability). Returns 403 otherwise.

Args:
  - status (enum): active | inactive | any. Default 'any'.
  - search (string): Optional keyword filter against plugin name/description.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  Array of WPPluginItem objects with shape:
  { plugin, status, name, plugin_uri, author, version, description, network_only, requires_wp, requires_php, textdomain }`,
      inputSchema: ListPluginsInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListPluginsInput) => {
      try {
        const wpParams: Record<string, unknown> = {};
        if (params.status !== "any") wpParams.status = params.status;
        if (params.search) wpParams.search = params.search;

        const result = await makeApiRequest<RawWpPlugin[]>(wpV2("plugins"), "GET", wpParams);
        const items = result.data.map(transformPlugin);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify({ count: items.length, items }, null, 2)
          : `# Plugins (${items.length})\n\n${items.map(formatPluginMarkdown).join("\n\n")}`;
        return toolResult(text, { count: items.length, items });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_get_settings --
  server.registerTool(
    "wp_get_settings",
    {
      title: "Get WordPress Settings",
      description: `Fetch WP general settings (title, tagline, admin email, timezone, date/time formats, posts-per-page, front page mode, default category, etc.).

Note: Requires admin (manage_options capability).

Args:
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  RawWpSettings object — see wp_get_site_info for the field list.`,
      inputSchema: GetSettingsInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetSettingsInput) => {
      try {
        const result = await makeApiRequest<RawWpSettings>(wpV2("settings"));
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(result.data, null, 2)
          : "# WP Settings\n\n" +
            Object.entries(result.data)
              .map(([k, v]) => `- **${k}**: ${typeof v === "string" ? v : JSON.stringify(v)}`)
              .join("\n");
        return toolResult(text, result.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_list_post_types --
  server.registerTool(
    "wp_list_post_types",
    {
      title: "List WordPress Post Types",
      description: `List all registered post types (built-in + custom). Useful for discovering custom post types added by Stagehand or other plugins (e.g. 'event', 'concert', 'season').

Args:
  - context (enum): view | edit. Default 'view'.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  Object keyed by post type slug, each value containing { name, slug, rest_base, rest_namespace, hierarchical, has_archive, taxonomies, description }`,
      inputSchema: ListPostTypesInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ListPostTypesInput) => {
      try {
        const result = await makeApiRequest<Record<string, RawWpPostType>>(
          wpV2("types"),
          "GET",
          { context: params.context }
        );
        const types = result.data;
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(types, null, 2)
          : `# Post Types (${Object.keys(types).length})\n\n` +
            Object.entries(types).map(([k, v]) => formatPostTypeMarkdown(k, v)).join("\n\n");
        return toolResult(text, types);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
