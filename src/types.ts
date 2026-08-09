/**
 * Shared TypeScript interfaces for ars-nova-wordpress-mcp.
 *
 * These describe the fields we actually return to MCP clients — they are a
 * SUBSET of the full WordPress REST response shape. WP returns many fields
 * we don't surface (e.g. _links, content rendering modes), filtered out in
 * the per-tool formatters.
 */

/** Output formatting choice surfaced on every tool. */
export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/** Generic pagination envelope used for every list response. */
export interface PaginatedResponse<T> {
  /** Total items the WP server reports for this query. */
  total: number;
  /** Items in this page. */
  count: number;
  /** Pagination offset for this response. */
  offset: number;
  /** The actual items. */
  items: T[];
  /** True if more items are available beyond this page. */
  has_more: boolean;
  /** Offset to pass on the next call. Omitted if has_more is false. */
  next_offset?: number;
  /** Set when the response was truncated due to CHARACTER_LIMIT. */
  truncated?: boolean;
  /** Human-readable explanation when truncated. */
  truncation_message?: string;
}

/** Subset of WP post / page fields we surface. */
export interface WPContentItem {
  id: number;
  date: string;            // ISO 8601
  modified: string;        // ISO 8601
  slug: string;
  status: string;          // publish | draft | pending | private | future | trash
  type: string;            // post | page | <custom-post-type>
  link: string;            // Public URL
  title: string;           // Rendered, plain text
  excerpt: string;         // Rendered, plain text (may be empty)
  content_preview: string; // First ~500 chars of plain-text content
  author_id: number;
  featured_media_id: number;
  categories?: number[];   // post-only
  tags?: number[];         // post-only
  parent?: number;         // page-only
  menu_order?: number;     // page-only
}

/** Subset of WP media fields we surface. */
export interface WPMediaItem {
  id: number;
  date: string;
  slug: string;
  title: string;
  alt_text: string;
  caption: string;
  description: string;
  media_type: string;      // image | file | video | audio
  mime_type: string;
  source_url: string;
  file_size?: number;
  width?: number;
  height?: number;
  author_id: number;
  attached_to_id: number;  // 0 if not attached to a post
}

/** Subset of WP user fields we surface. */
export interface WPUserItem {
  id: number;
  name: string;            // display name
  slug: string;
  url: string;
  description: string;
  link: string;            // author archive URL
  roles?: string[];        // visible only when caller has list_users cap
  capabilities?: Record<string, boolean>;
  registered_date?: string;
}

/** Subset of WP taxonomy term fields we surface. */
export interface WPTermItem {
  id: number;
  name: string;
  slug: string;
  description: string;
  count: number;           // # of posts/pages tagged with this term
  parent: number;          // 0 for top-level
  link: string;
}

/** Plugin entry as returned by /wp/v2/plugins (admin-only endpoint). */
export interface WPPluginItem {
  plugin: string;          // file path identifier, e.g. "akismet/akismet"
  status: string;          // active | inactive
  name: string;
  plugin_uri: string;
  author: string;
  version: string;
  description: string;
  network_only: boolean;
  requires_wp: string;
  requires_php: string;
  textdomain: string;
}

/** Theme entry as returned by /wp/v2/themes (admin-only endpoint). */
export interface WPThemeItem {
  stylesheet: string;      // theme directory name
  template: string;        // parent theme directory name (same as stylesheet for non-child themes)
  name: string;
  status: string;          // active | inactive
  version: string;
  author: string;
  author_uri: string;
  description: string;
  theme_uri: string;
  is_child_theme: boolean;
  requires_wp: string;
  requires_php: string;
  tags: string[];
  textdomain: string;
  screenshot?: string;
}

/** Site-level info combining /wp/v2 root + /wp/v2/settings. */
export interface WPSiteInfo {
  site_url: string;
  api_namespaces: string[];     // From /wp/v2 root — e.g. ["wp/v2", "wp-block-editor/v1", "yoast/v1", ...]
  api_authentication: string[]; // E.g. ["application-passwords"]
  // From /wp/v2/settings (admin-only):
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

/** Detected SEO plugin and the per-content-item meta we extract. */
export interface WPSeoMetaResult {
  detected_plugin: "yoast" | "rankmath" | "aioseo" | "none";
  // Common fields normalized across plugins where possible:
  meta_title?: string;
  meta_description?: string;
  canonical_url?: string;
  noindex?: boolean;
  og_title?: string;
  og_description?: string;
  og_image?: string;
  twitter_title?: string;
  twitter_description?: string;
  twitter_image?: string;
  focus_keyword?: string;
  // Fall back to raw plugin-specific fields when normalization isn't possible:
  raw?: Record<string, unknown>;
}

/** Result of the alt-text audit. */
export interface WPAltTextAuditResult {
  total_media_scanned: number;
  total_images_scanned: number;
  missing_alt_count: number;
  missing_alt_items: Array<{
    id: number;
    title: string;
    source_url: string;
    attached_to_id: number;
  }>;
  has_more: boolean;
  next_offset?: number;
}
