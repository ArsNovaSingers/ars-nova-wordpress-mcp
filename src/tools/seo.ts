/**
 * SEO tools — extract per-page SEO meta from whichever SEO plugin is active
 * (Yoast / RankMath / AIOSEO), and audit alt text across the media library.
 *
 * Detection strategy: query /wp-json (root) namespaces. If 'yoast/v1' is
 * present we have Yoast; if 'rankmath/v1' is present we have RankMath; etc.
 * Most SEO plugins ALSO surface their meta inline on /wp/v2/posts and
 * /wp/v2/pages responses under fields like `yoast_head_json`, `rank_math`,
 * or `aioseo`. We try inline first (cheaper), fall back to namespace probe.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest, wpV2 } from "../services/wp-client.js";
import {
  toolError,
  toolResult,
} from "../services/formatters.js";
import { PaginationSchema, ResponseFormatField } from "../schemas/common.js";
import {
  ResponseFormat,
  type WPAltTextAuditResult,
  type WPSeoMetaResult,
} from "../types.js";

// -----------------------------------------------------------------------------
// wp_get_seo_meta
// -----------------------------------------------------------------------------

const GetSeoMetaInputSchema = z.object({
  content_type: z.enum(["post", "page"])
    .describe("Whether the target is a post or a page."),
  id: z.number().int().positive().optional()
    .describe("Numeric ID of the target. Either id OR slug is required."),
  slug: z.string().optional()
    .describe("Slug of the target. Either id OR slug is required."),
  response_format: ResponseFormatField,
}).strict();

type GetSeoMetaInput = z.infer<typeof GetSeoMetaInputSchema>;

interface YoastHeadJson {
  title?: string;
  description?: string;
  canonical?: string;
  robots?: { index?: string; follow?: string };
  og_title?: string;
  og_description?: string;
  og_image?: Array<{ url?: string }>;
  twitter_title?: string;
  twitter_description?: string;
  twitter_image?: string;
}

interface RankMathMeta {
  title?: string;
  description?: string;
  canonical_url?: string;
  robots?: { index?: string; follow?: string };
  focus_keyword?: string;
  og_title?: string;
  og_description?: string;
  og_image?: string;
  twitter_title?: string;
  twitter_description?: string;
  twitter_image?: string;
}

interface RawContentWithSeo {
  yoast_head_json?: YoastHeadJson;
  rank_math?: RankMathMeta;
  aioseo?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

function detectAndExtractSeo(raw: RawContentWithSeo): WPSeoMetaResult {
  if (raw.yoast_head_json) {
    const y = raw.yoast_head_json;
    return {
      detected_plugin: "yoast",
      ...(y.title !== undefined ? { meta_title: y.title } : {}),
      ...(y.description !== undefined ? { meta_description: y.description } : {}),
      ...(y.canonical !== undefined ? { canonical_url: y.canonical } : {}),
      ...(y.robots?.index ? { noindex: y.robots.index === "noindex" } : {}),
      ...(y.og_title !== undefined ? { og_title: y.og_title } : {}),
      ...(y.og_description !== undefined ? { og_description: y.og_description } : {}),
      ...(y.og_image?.[0]?.url ? { og_image: y.og_image[0].url } : {}),
      ...(y.twitter_title !== undefined ? { twitter_title: y.twitter_title } : {}),
      ...(y.twitter_description !== undefined ? { twitter_description: y.twitter_description } : {}),
      ...(y.twitter_image !== undefined ? { twitter_image: y.twitter_image } : {}),
      raw: y as unknown as Record<string, unknown>,
    };
  }
  if (raw.rank_math) {
    const r = raw.rank_math;
    return {
      detected_plugin: "rankmath",
      ...(r.title !== undefined ? { meta_title: r.title } : {}),
      ...(r.description !== undefined ? { meta_description: r.description } : {}),
      ...(r.canonical_url !== undefined ? { canonical_url: r.canonical_url } : {}),
      ...(r.robots?.index ? { noindex: r.robots.index === "noindex" } : {}),
      ...(r.focus_keyword !== undefined ? { focus_keyword: r.focus_keyword } : {}),
      ...(r.og_title !== undefined ? { og_title: r.og_title } : {}),
      ...(r.og_description !== undefined ? { og_description: r.og_description } : {}),
      ...(r.og_image !== undefined ? { og_image: r.og_image } : {}),
      ...(r.twitter_title !== undefined ? { twitter_title: r.twitter_title } : {}),
      ...(r.twitter_description !== undefined ? { twitter_description: r.twitter_description } : {}),
      ...(r.twitter_image !== undefined ? { twitter_image: r.twitter_image } : {}),
      raw: r as unknown as Record<string, unknown>,
    };
  }
  if (raw.aioseo) {
    return {
      detected_plugin: "aioseo",
      raw: raw.aioseo,
    };
  }
  return {
    detected_plugin: "none",
    ...(raw.meta ? { raw: raw.meta } : {}),
  };
}

function formatSeoMetaMarkdown(seo: WPSeoMetaResult, contentType: string, identifier: string): string {
  const lines = [
    `# SEO Meta for ${contentType} '${identifier}'`,
    "",
    `**Detected SEO plugin**: ${seo.detected_plugin}`,
    "",
  ];
  if (seo.detected_plugin === "none") {
    lines.push("No supported SEO plugin detected on this content. Yoast, RankMath, and AIOSEO are recognized; other plugins may store meta in custom fields not exposed via REST.");
    return lines.join("\n");
  }
  if (seo.meta_title !== undefined) lines.push(`- **Meta title**: ${seo.meta_title}`);
  if (seo.meta_description !== undefined) lines.push(`- **Meta description**: ${seo.meta_description}`);
  if (seo.canonical_url !== undefined) lines.push(`- **Canonical URL**: ${seo.canonical_url}`);
  if (seo.noindex !== undefined) lines.push(`- **Noindex**: ${seo.noindex}`);
  if (seo.focus_keyword !== undefined) lines.push(`- **Focus keyword**: ${seo.focus_keyword}`);
  if (seo.og_title !== undefined) lines.push(`- **OG title**: ${seo.og_title}`);
  if (seo.og_description !== undefined) lines.push(`- **OG description**: ${seo.og_description}`);
  if (seo.og_image !== undefined) lines.push(`- **OG image**: ${seo.og_image}`);
  if (seo.twitter_title !== undefined) lines.push(`- **Twitter title**: ${seo.twitter_title}`);
  if (seo.twitter_description !== undefined) lines.push(`- **Twitter description**: ${seo.twitter_description}`);
  if (seo.twitter_image !== undefined) lines.push(`- **Twitter image**: ${seo.twitter_image}`);
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// wp_audit_alt_text
// -----------------------------------------------------------------------------

const AuditAltTextInputSchema = PaginationSchema.extend({
  scan_limit: z.number().int().min(1).max(500).default(100)
    .describe("How many media items to scan in this call (1-500). Default 100."),
  response_format: ResponseFormatField,
}).strict();

type AuditAltTextInput = z.infer<typeof AuditAltTextInputSchema>;

interface RawMediaForAudit {
  id: number;
  title?: { rendered?: string };
  alt_text?: string;
  source_url: string;
  post: number;
  media_type: string;
}

function formatAltAuditMarkdown(result: WPAltTextAuditResult): string {
  const lines = [
    `# Alt Text Audit`,
    "",
    `- **Media items scanned**: ${result.total_media_scanned}`,
    `- **Images scanned**: ${result.total_images_scanned}`,
    `- **Images missing alt text**: ${result.missing_alt_count}`,
    "",
  ];
  if (result.missing_alt_count === 0) {
    lines.push("All scanned images have alt text. Good job.");
  } else {
    lines.push(`## Missing alt text (${result.missing_alt_items.length} of ${result.missing_alt_count}):`);
    lines.push("");
    for (const item of result.missing_alt_items) {
      lines.push(`- **${item.title || "(untitled)"}** (ID ${item.id}) — ${item.source_url}` +
        (item.attached_to_id ? ` — attached to post ${item.attached_to_id}` : ""));
    }
  }
  if (result.has_more) {
    lines.push("");
    lines.push(`> More media exists beyond this scan window. Re-run with offset=${result.next_offset} to continue.`);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------


// -----------------------------------------------------------------------------
// Write schemas (Phase 2) — Yoast SEO meta updates
// -----------------------------------------------------------------------------

const UpdateSeoMetaInputSchema = z.object({
  content_type: z.enum(["post", "page"])
    .describe("Whether the target is a post or a page."),
  id: z.number().int().positive()
    .describe("Numeric ID of the post or page."),
  meta_title: z.string().optional()
    .describe("SEO title (Yoast). Shown in search results. Recommended 50-60 chars."),
  meta_description: z.string().optional()
    .describe("SEO description (Yoast). Recommended 150-160 chars."),
  canonical_url: z.string().optional()
    .describe("Canonical URL. Pass empty string to clear and let Yoast auto-set."),
  noindex: z.boolean().optional()
    .describe("If true, sets robots noindex. If false, sets robots index. Leave undefined to use Yoast's default."),
  focus_keyword: z.string().optional()
    .describe("Yoast focus keyword for the analysis tool."),
  og_title: z.string().optional()
    .describe("Open Graph title override (Facebook/LinkedIn share)."),
  og_description: z.string().optional()
    .describe("Open Graph description override."),
  twitter_title: z.string().optional()
    .describe("Twitter card title override."),
  twitter_description: z.string().optional()
    .describe("Twitter card description override."),
  response_format: ResponseFormatField,
}).strict();

type UpdateSeoMetaInput = z.infer<typeof UpdateSeoMetaInputSchema>;

/** Map our normalized field names to Yoast's underlying postmeta keys. */
const YOAST_META_KEY_MAP: Record<string, string> = {
  meta_title: "_yoast_wpseo_title",
  meta_description: "_yoast_wpseo_metadesc",
  canonical_url: "_yoast_wpseo_canonical",
  focus_keyword: "_yoast_wpseo_focuskw",
  og_title: "_yoast_wpseo_opengraph-title",
  og_description: "_yoast_wpseo_opengraph-description",
  twitter_title: "_yoast_wpseo_twitter-title",
  twitter_description: "_yoast_wpseo_twitter-description",
};
export function registerSeoTools(server: McpServer): void {
  // -- wp_get_seo_meta --
  server.registerTool(
    "wp_get_seo_meta",
    {
      title: "Get WordPress SEO Meta",
      description: `Get SEO meta (title, description, canonical, OG/Twitter, focus keyword) for a single post or page. Auto-detects the active SEO plugin (Yoast, RankMath, AIOSEO) and normalizes the fields where possible.

Either 'id' or 'slug' must be provided.

Args:
  - content_type (enum): post | page. Required.
  - id (number): Numeric ID of target. Mutually exclusive with slug.
  - slug (string): Slug of target. Mutually exclusive with id.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  WPSeoMetaResult object with shape:
  {
    "detected_plugin": "yoast" | "rankmath" | "aioseo" | "none",
    "meta_title"?: string,
    "meta_description"?: string,
    "canonical_url"?: string,
    "noindex"?: boolean,
    "og_title"?: string, "og_description"?: string, "og_image"?: string,
    "twitter_title"?: string, "twitter_description"?: string, "twitter_image"?: string,
    "focus_keyword"?: string,
    "raw"?: object  // The raw plugin-specific blob for reference
  }`,
      inputSchema: GetSeoMetaInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GetSeoMetaInput) => {
      try {
        if (!params.id && !params.slug) {
          return toolError("Either 'id' or 'slug' must be provided.");
        }
        const collection = params.content_type === "post" ? "posts" : "pages";

        let raw: RawContentWithSeo & { id: number; slug: string };
        if (params.id) {
          const result = await makeApiRequest<RawContentWithSeo & { id: number; slug: string }>(
            wpV2(`${collection}/${params.id}`)
          );
          raw = result.data;
        } else {
          const result = await makeApiRequest<Array<RawContentWithSeo & { id: number; slug: string }>>(
            wpV2(collection),
            "GET",
            { slug: params.slug, per_page: 1 }
          );
          if (!result.data.length) {
            return toolError(`No ${params.content_type} found with slug '${params.slug}'.`);
          }
          raw = result.data[0]!;
        }

        const seo = detectAndExtractSeo(raw);
        const identifier = params.slug || `id ${raw.id}`;
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(seo, null, 2)
          : formatSeoMetaMarkdown(seo, params.content_type, identifier);
        return toolResult(text, seo);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // -- wp_audit_alt_text --
  server.registerTool(
    "wp_audit_alt_text",
    {
      title: "Audit Alt Text",
      description: `Scan the media library and report which IMAGE items are missing alt text. Skips non-image media (video/audio/file). Designed to be paginated for large libraries — start at offset 0, then re-run with the returned next_offset.

Args:
  - scan_limit (number): How many media items to scan in this call, 1-500. Default 100.
  - limit (number): How many missing-alt items to return in the result. Default 20.
  - offset (number): Pagination offset INTO THE MEDIA LIBRARY (not into the missing list). Default 0.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  WPAltTextAuditResult object with shape:
  {
    "total_media_scanned": number,
    "total_images_scanned": number,
    "missing_alt_count": number,
    "missing_alt_items": [
      { "id": number, "title": string, "source_url": string, "attached_to_id": number }
    ],
    "has_more": boolean,
    "next_offset": number  // Present if has_more
  }

  Note: missing_alt_count is the count WITHIN this scan window only. Re-run with
  the returned next_offset to continue scanning the rest of the library.`,
      inputSchema: AuditAltTextInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: AuditAltTextInput) => {
      try {
        // WP REST API caps per_page at 100. We loop internally in chunks of 100
        // so the caller can request scan_limit up to 500 in a single tool call.
        const WP_MAX_PER_PAGE = 100;
        const scanned: RawMediaForAudit[] = [];
        let currentOffset = params.offset;
        let totalReportedByWp = 0;
        let exhausted = false;

        while (scanned.length < params.scan_limit) {
          const remaining = params.scan_limit - scanned.length;
          const perPage = Math.min(WP_MAX_PER_PAGE, remaining);
          const result = await makeApiRequest<RawMediaForAudit[]>(wpV2("media"), "GET", {
            per_page: perPage,
            offset: currentOffset,
            media_type: "image",
            orderby: "id",
            order: "asc",
          });
          totalReportedByWp = result.total;
          if (result.data.length === 0) {
            exhausted = true;
            break;
          }
          scanned.push(...result.data);
          currentOffset += result.data.length;
          if (result.data.length < perPage) {
            // WP returned fewer than asked — library exhausted.
            exhausted = true;
            break;
          }
        }

        const images = scanned.filter((m) => m.media_type === "image");
        const missing = images.filter((m) => !m.alt_text || m.alt_text.trim() === "");
        const missingItems = missing.slice(0, params.limit).map((m) => ({
          id: m.id,
          title: (m.title?.rendered || "").replace(/<[^>]+>/g, ""),
          source_url: m.source_url,
          attached_to_id: m.post,
        }));

        const hasMore = !exhausted && totalReportedByWp > params.offset + scanned.length;

        const auditResult: WPAltTextAuditResult = {
          total_media_scanned: scanned.length,
          total_images_scanned: images.length,
          missing_alt_count: missing.length,
          missing_alt_items: missingItems,
          has_more: hasMore,
          ...(hasMore ? { next_offset: params.offset + scanned.length } : {}),
        };

        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(auditResult, null, 2)
          : formatAltAuditMarkdown(auditResult);
        return toolResult(text, auditResult);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Phase 2 — Write tool
  // ---------------------------------------------------------------------------

  // -- wp_update_seo_meta --
  server.registerTool(
    "wp_update_seo_meta",
    {
      title: "Update WordPress SEO Meta (Yoast)",
      description: `Update Yoast SEO meta on a post or page: title, description, canonical, noindex, focus keyword, OG, Twitter. Writes via WP REST's meta sub-object using Yoast's underlying postmeta keys.

Args:
  - content_type (enum): post | page. Required.
  - id (number): ID of the post/page. Required.
  - meta_title, meta_description, canonical_url, focus_keyword: optional strings.
  - noindex (boolean): true = noindex, false = index, undefined = leave Yoast's default.
  - og_title, og_description, twitter_title, twitter_description: optional social-share overrides.
  - response_format (enum): markdown | json. Default 'markdown'.

Returns:
  The updated content item (with the new Yoast meta applied — re-fetch with wp_get_seo_meta to verify rendering).

Note: This is for Yoast specifically. RankMath / AIOSEO sites need different keys (not supported in v1).`,
      inputSchema: UpdateSeoMetaInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: UpdateSeoMetaInput) => {
      try {
        const meta: Record<string, unknown> = {};
        for (const [field, yoastKey] of Object.entries(YOAST_META_KEY_MAP)) {
          const value = (params as Record<string, unknown>)[field];
          if (value !== undefined) {
            meta[yoastKey] = value;
          }
        }
        if (params.noindex !== undefined) {
          // Yoast stores noindex as "1" (noindex) or "2" (index/default).
          // The "_yoast_wpseo_meta-robots-noindex" key uses these string values.
          meta["_yoast_wpseo_meta-robots-noindex"] = params.noindex ? "1" : "2";
        }
        if (Object.keys(meta).length === 0) {
          return toolError("Pass at least one SEO field to update.");
        }

        const collection = params.content_type === "post" ? "posts" : "pages";
        const result = await makeApiRequest<{ id: number; slug: string; link: string; title?: { rendered?: string } }>(
          wpV2(`${collection}/${params.id}`),
          "PUT",
          undefined,
          { meta }
        );

        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify({ id: result.data.id, slug: result.data.slug, link: result.data.link, meta_keys_set: Object.keys(meta) }, null, 2)
          : `# Updated Yoast SEO meta on ${params.content_type} ID ${result.data.id}\n\nFields set: ${Object.keys(meta).join(", ")}\n\nRe-run wp_get_seo_meta to confirm the rendered values.`;
        return toolResult(text, { id: result.data.id, slug: result.data.slug, link: result.data.link, meta_keys_set: Object.keys(meta) });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
