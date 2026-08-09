# ars-nova-wordpress-mcp

Local MCP server for managing **arsnovasingers.org** via the WordPress REST API.

Built for Jonathan Raabe (Marketing Director, Ars Nova Singers) so Claude can
read, audit, and (in later phases) update the WordPress site directly.

## Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Read-only audit (posts, pages, media, users, plugins, themes, settings, SEO meta) | In progress |
| 2 | Content writes (create/update posts + pages, upload media) | Planned |
| 2.5 | WPEngine API integration (cache flush, perf metrics, backups) | Deferred until needed |
| 3 | Custom Ars Nova endpoints (events, season pages, ACF fields if discovered) | Planned |
| 4 | Eval suite (10 read-only complex questions) | Planned |

## Setup

### 1. Generate a WordPress Application Password

1. Log into wp-admin at https://arsnovasingers.org/wp-admin
2. Go to **Users → Profile**
3. Scroll to **Application Passwords**
4. Name it `claude-mcp` and click **Add New Application Password**
5. Copy the 24-character password — WordPress only shows it once

### 2. Install + build

```bash
cd ars-nova-wordpress-mcp
npm install
npm run build
```

This produces `dist/index.js` which is the entry point Claude Desktop runs.

### 3. Add to `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ars-nova-wordpress": {
      "command": "node",
      "args": [
        "C:\\Users\\jonra\\Claud Projects\\Ars Nova\\Ars Nova\\ars-nova-wordpress-mcp\\dist\\index.js"
      ],
      "env": {
        "WP_SITE_URL": "https://arsnovasingers.org",
        "WP_USERNAME": "your_wp_username",
        "WP_APP_PASSWORD": "your_24_char_password"
      }
    }
  }
}
```

Restart Claude Desktop after editing.

### 4. Smoke test

In a Claude Desktop conversation, ask:
> Use the ars-nova-wordpress MCP to call `wp_get_site_info`.

If it returns the site name, tagline, and WP version, auth is working.

## Tool list (Phase 1)

### Content
- `wp_list_posts` — list posts with filters
- `wp_get_post` — fetch one post by ID or slug
- `wp_list_pages` — list pages with filters
- `wp_get_page` — fetch one page by ID or slug
- `wp_search_content` — search across posts and pages

### Media
- `wp_list_media` — list media library items
- `wp_get_media_item` — fetch one media item with full metadata

### Users
- `wp_list_users` — list users and their roles
- `wp_get_user` — fetch one user by ID

### Taxonomy
- `wp_list_categories` — list categories
- `wp_list_tags` — list tags

### Site
- `wp_get_site_info` — site name, tagline, WP version, REST namespaces
- `wp_list_themes` — installed themes (active flagged)
- `wp_list_plugins` — installed plugins (active flagged, version reported)
- `wp_get_settings` — general WP settings
- `wp_list_post_types` — registered post types (reveals custom post types)

### SEO
- `wp_get_seo_meta` — auto-detects Yoast / RankMath / AIOSEO and returns the per-page SEO meta
- `wp_audit_alt_text` — scans the media library for items missing alt text

## Tool conventions

Every tool:

- Uses snake_case naming with `wp_` prefix
- Validates inputs with Zod (`.strict()`)
- Supports `response_format: "markdown" | "json"` (default markdown)
- Implements pagination with `limit`, `offset`, `has_more`, `next_offset`
- Returns both `content[]` (text) and `structuredContent` (typed object)
- Declares MCP annotations: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`
- Truncates responses larger than `CHARACTER_LIMIT` (25,000) with a clear message
- Surfaces 401/403/429 errors with actionable next-step guidance

## Auth model

WordPress Application Passwords (built into WP 5.6+, no plugin required).
Sent as Basic Auth on every request. Application Passwords can be revoked
individually from the WP profile page without affecting the user's normal login.

## Project structure

```
ars-nova-wordpress-mcp/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts             # Entry point — registers all tools, starts stdio transport
│   ├── constants.ts         # CHARACTER_LIMIT, default limits, API namespace
│   ├── types.ts             # Shared TypeScript interfaces
│   ├── services/
│   │   └── wp-client.ts     # Axios client with auth + shared error handling
│   ├── schemas/
│   │   └── common.ts        # Shared Zod schemas (pagination, response_format)
│   └── tools/
│       ├── content.ts       # Posts, pages, search
│       ├── media.ts         # Media library
│       ├── users.ts         # Users, roles
│       ├── taxonomy.ts      # Categories, tags
│       ├── site.ts          # Site info, themes, plugins, settings, post types
│       └── seo.ts           # SEO meta + alt text audit
└── dist/                    # Build output — entry point: dist/index.js
```
