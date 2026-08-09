/**
 * Bulk CSV-driven write tools.
 *
 * All bulk tools share these conventions:
 *   - csv_path is required (absolute or relative-to-cwd path on the MCP host).
 *   - dry_run defaults to TRUE — the tool reports what WOULD happen without writing.
 *     Pass dry_run: false explicitly to actually write to WP.
 *   - stop_on_error defaults to FALSE — failed rows are reported but the loop
 *     continues. Pass true to halt at the first error.
 *   - Per-row results are returned in `results[]` with ok/error status and the
 *     specific WP message on failure.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest, wpV2 } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";
import {
  cellToInt,
  cellToIntArray,
  cellToOptionalString,
  cellToStringArray,
  parseCsvFile,
  type CsvRow,
} from "../services/csv.js";

// -----------------------------------------------------------------------------
// Shared bulk result shape
// -----------------------------------------------------------------------------

interface BulkRowResult {
  row_index: number;          // 1-indexed, matching the CSV (excluding header)
  ok: boolean;
  id?: number;                // Resulting WP entity ID (on success)
  message: string;            // Human description of what happened
}

interface BulkSummary {
  dry_run: boolean;
  total_rows: number;
  succeeded: number;
  failed: number;
  results: BulkRowResult[];
}

function summarizeMarkdown(toolName: string, summary: BulkSummary): string {
  const lines: string[] = [
    `# ${toolName}${summary.dry_run ? " (DRY RUN)" : ""}`,
    "",
    `- **Total rows**: ${summary.total_rows}`,
    `- **Succeeded**: ${summary.succeeded}`,
    `- **Failed**: ${summary.failed}`,
    "",
  ];
  if (summary.dry_run) {
    lines.push("> No changes were applied. Re-run with `dry_run: false` to write.");
    lines.push("");
  }
  lines.push("## Per-row results");
  lines.push("");
  for (const r of summary.results) {
    const icon = r.ok ? "OK " : "ERR";
    lines.push(`- [${icon}] Row ${r.row_index}${r.id ? ` (id ${r.id})` : ""}: ${r.message}`);
  }
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// wp_bulk_update_posts
// -----------------------------------------------------------------------------

const BulkUpdatePostsInputSchema = z.object({
  csv_path: z.string().min(1)
    .describe("Path to CSV. Required columns: id. Optional columns: title, content, status, slug, excerpt, categories (comma-sep IDs), tags (comma-sep IDs), featured_media."),
  dry_run: z.boolean().default(true)
    .describe("Default true. Set false to actually write."),
  stop_on_error: z.boolean().default(false)
    .describe("Default false (continue on errors). True = stop at first error."),
  response_format: ResponseFormatField,
}).strict();

type BulkUpdatePostsInput = z.infer<typeof BulkUpdatePostsInputSchema>;

// -----------------------------------------------------------------------------
// wp_bulk_update_media_alt_text
// -----------------------------------------------------------------------------

const BulkUpdateMediaAltTextInputSchema = z.object({
  csv_path: z.string().min(1)
    .describe("Path to CSV. Required columns: id, alt_text. Optional columns: caption, description, title."),
  dry_run: z.boolean().default(true),
  stop_on_error: z.boolean().default(false),
  response_format: ResponseFormatField,
}).strict();

type BulkUpdateMediaAltTextInput = z.infer<typeof BulkUpdateMediaAltTextInputSchema>;

// -----------------------------------------------------------------------------
// wp_bulk_update_users
// -----------------------------------------------------------------------------

const BulkUpdateUsersInputSchema = z.object({
  csv_path: z.string().min(1)
    .describe("Path to CSV. Required columns: id. Optional columns: roles (single role like 'editor' or comma-sep for multiple), email, first_name, last_name, name, description."),
  dry_run: z.boolean().default(true),
  stop_on_error: z.boolean().default(false),
  response_format: ResponseFormatField,
}).strict();

type BulkUpdateUsersInput = z.infer<typeof BulkUpdateUsersInputSchema>;

// -----------------------------------------------------------------------------
// wp_bulk_create_posts
// -----------------------------------------------------------------------------

const BulkCreatePostsInputSchema = z.object({
  csv_path: z.string().min(1)
    .describe("Path to CSV. Required columns: title, content. Optional columns: status (default 'draft'), slug, excerpt, categories (comma-sep IDs), tags (comma-sep IDs), date, featured_media."),
  dry_run: z.boolean().default(true),
  stop_on_error: z.boolean().default(false),
  response_format: ResponseFormatField,
}).strict();

type BulkCreatePostsInput = z.infer<typeof BulkCreatePostsInputSchema>;

// -----------------------------------------------------------------------------
// wp_bulk_assign_terms
// -----------------------------------------------------------------------------

const BulkAssignTermsInputSchema = z.object({
  csv_path: z.string().min(1)
    .describe("Path to CSV. Required columns: post_id, taxonomy (category|tag), term_names (comma-sep names — missing tags are auto-created)."),
  dry_run: z.boolean().default(true),
  stop_on_error: z.boolean().default(false),
  auto_create_missing: z.boolean().default(true)
    .describe("If a term name doesn't exist: create it (true, default) or fail the row (false)."),
  response_format: ResponseFormatField,
}).strict();

type BulkAssignTermsInput = z.infer<typeof BulkAssignTermsInputSchema>;

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export function registerBulkTools(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // wp_bulk_update_posts
  // ---------------------------------------------------------------------------
  server.registerTool(
    "wp_bulk_update_posts",
    {
      title: "Bulk Update Posts from CSV",
      description: `Update many posts from a CSV. Required column: id. Optional: title, content, status, slug, excerpt, categories (comma-separated IDs), tags (comma-separated IDs), featured_media. Empty cells are SKIPPED (no change to that field). Defaults to dry_run=true.

Args:
  - csv_path (string): Path to CSV file. Required.
  - dry_run (boolean): Default true. Set false to apply changes.
  - stop_on_error (boolean): Default false.
  - response_format (enum): markdown | json. Default 'markdown'.

Use case: backfill categories on the 45 "Uncategorized" posts.`,
      inputSchema: BulkUpdatePostsInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: BulkUpdatePostsInput) => {
      try {
        const parsed = parseCsvFile(params.csv_path, {
          requiredColumns: ["id"],
        });
        const summary: BulkSummary = {
          dry_run: params.dry_run,
          total_rows: parsed.rowCount,
          succeeded: 0,
          failed: 0,
          results: [],
        };

        for (let i = 0; i < parsed.rows.length; i++) {
          const row: CsvRow = parsed.rows[i]!;
          const rowIndex = i + 2;
          try {
            const id = cellToInt(row["id"]);
            if (id === undefined) throw new Error("Missing or invalid id.");

            const payload: Record<string, unknown> = {};
            if (cellToOptionalString(row["title"]) !== undefined) payload["title"] = row["title"];
            if (cellToOptionalString(row["content"]) !== undefined) payload["content"] = row["content"];
            if (cellToOptionalString(row["status"]) !== undefined) payload["status"] = row["status"];
            if (cellToOptionalString(row["slug"]) !== undefined) payload["slug"] = row["slug"];
            if (cellToOptionalString(row["excerpt"]) !== undefined) payload["excerpt"] = row["excerpt"];
            const cats = cellToIntArray(row["categories"]);
            if (cats !== undefined) payload["categories"] = cats;
            const tags = cellToIntArray(row["tags"]);
            if (tags !== undefined) payload["tags"] = tags;
            const fm = cellToInt(row["featured_media"]);
            if (fm !== undefined) payload["featured_media"] = fm;

            if (Object.keys(payload).length === 0) {
              throw new Error("No updatable fields in row.");
            }

            if (params.dry_run) {
              summary.results.push({
                row_index: rowIndex,
                ok: true,
                id,
                message: `[dry-run] Would update post ${id} with fields: ${Object.keys(payload).join(", ")}`,
              });
              summary.succeeded++;
            } else {
              const result = await makeApiRequest<{ id: number; slug: string }>(
                wpV2(`posts/${id}`),
                "PUT",
                undefined,
                payload
              );
              summary.results.push({
                row_index: rowIndex,
                ok: true,
                id: result.data.id,
                message: `Updated post ${result.data.id} (slug: ${result.data.slug}). Fields: ${Object.keys(payload).join(", ")}`,
              });
              summary.succeeded++;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            summary.results.push({ row_index: rowIndex, ok: false, message: msg });
            summary.failed++;
            if (params.stop_on_error) break;
          }
        }

        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(summary, null, 2)
          : summarizeMarkdown("Bulk update posts", summary);
        return toolResult(text, summary);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ---------------------------------------------------------------------------
  // wp_bulk_update_media_alt_text
  // ---------------------------------------------------------------------------
  server.registerTool(
    "wp_bulk_update_media_alt_text",
    {
      title: "Bulk Update Media Alt Text from CSV",
      description: `Backfill alt text (and optionally caption/description/title) across many media items from a CSV. Required columns: id, alt_text. Optional: caption, description, title. Defaults to dry_run=true.

Use case: the 2020-era alt-text backfill on arsnovasingers.org.`,
      inputSchema: BulkUpdateMediaAltTextInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: BulkUpdateMediaAltTextInput) => {
      try {
        const parsed = parseCsvFile(params.csv_path, {
          requiredColumns: ["id", "alt_text"],
        });
        const summary: BulkSummary = {
          dry_run: params.dry_run,
          total_rows: parsed.rowCount,
          succeeded: 0,
          failed: 0,
          results: [],
        };

        for (let i = 0; i < parsed.rows.length; i++) {
          const row = parsed.rows[i]!;
          const rowIndex = i + 2;
          try {
            const id = cellToInt(row["id"]);
            if (id === undefined) throw new Error("Missing or invalid id.");

            const payload: Record<string, unknown> = { alt_text: row["alt_text"] };
            if (cellToOptionalString(row["caption"]) !== undefined) payload["caption"] = row["caption"];
            if (cellToOptionalString(row["description"]) !== undefined) payload["description"] = row["description"];
            if (cellToOptionalString(row["title"]) !== undefined) payload["title"] = row["title"];

            if (params.dry_run) {
              summary.results.push({
                row_index: rowIndex,
                ok: true,
                id,
                message: `[dry-run] Would set alt_text on media ${id} to "${row["alt_text"]}"`,
              });
              summary.succeeded++;
            } else {
              const result = await makeApiRequest<{ id: number; alt_text?: string }>(
                wpV2(`media/${id}`),
                "PUT",
                undefined,
                payload
              );
              summary.results.push({
                row_index: rowIndex,
                ok: true,
                id: result.data.id,
                message: `Updated media ${result.data.id} alt_text -> "${result.data.alt_text}"`,
              });
              summary.succeeded++;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            summary.results.push({ row_index: rowIndex, ok: false, message: msg });
            summary.failed++;
            if (params.stop_on_error) break;
          }
        }

        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(summary, null, 2)
          : summarizeMarkdown("Bulk update media alt text", summary);
        return toolResult(text, summary);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ---------------------------------------------------------------------------
  // wp_bulk_update_users
  // ---------------------------------------------------------------------------
  server.registerTool(
    "wp_bulk_update_users",
    {
      title: "Bulk Update Users from CSV",
      description: `Update many users from a CSV. Required column: id. Optional: roles (single role like 'subscriber' or comma-sep for multiple), email, first_name, last_name, name, description. Defaults to dry_run=true.

Use case: demote stale admins identified in the website audit.`,
      inputSchema: BulkUpdateUsersInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: BulkUpdateUsersInput) => {
      try {
        const parsed = parseCsvFile(params.csv_path, {
          requiredColumns: ["id"],
        });
        const summary: BulkSummary = {
          dry_run: params.dry_run,
          total_rows: parsed.rowCount,
          succeeded: 0,
          failed: 0,
          results: [],
        };

        for (let i = 0; i < parsed.rows.length; i++) {
          const row = parsed.rows[i]!;
          const rowIndex = i + 2;
          try {
            const id = cellToInt(row["id"]);
            if (id === undefined) throw new Error("Missing or invalid id.");

            const payload: Record<string, unknown> = {};
            const roles = cellToStringArray(row["roles"]);
            if (roles !== undefined) payload["roles"] = roles;
            if (cellToOptionalString(row["email"]) !== undefined) payload["email"] = row["email"];
            if (cellToOptionalString(row["first_name"]) !== undefined) payload["first_name"] = row["first_name"];
            if (cellToOptionalString(row["last_name"]) !== undefined) payload["last_name"] = row["last_name"];
            if (cellToOptionalString(row["name"]) !== undefined) payload["name"] = row["name"];
            if (cellToOptionalString(row["description"]) !== undefined) payload["description"] = row["description"];

            if (Object.keys(payload).length === 0) {
              throw new Error("No updatable fields in row.");
            }

            if (params.dry_run) {
              summary.results.push({
                row_index: rowIndex,
                ok: true,
                id,
                message: `[dry-run] Would update user ${id} with fields: ${Object.keys(payload).join(", ")}`,
              });
              summary.succeeded++;
            } else {
              const result = await makeApiRequest<{ id: number; slug: string }>(
                wpV2(`users/${id}`),
                "PUT",
                undefined,
                payload
              );
              summary.results.push({
                row_index: rowIndex,
                ok: true,
                id: result.data.id,
                message: `Updated user ${result.data.id} (slug: ${result.data.slug}). Fields: ${Object.keys(payload).join(", ")}`,
              });
              summary.succeeded++;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            summary.results.push({ row_index: rowIndex, ok: false, message: msg });
            summary.failed++;
            if (params.stop_on_error) break;
          }
        }

        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(summary, null, 2)
          : summarizeMarkdown("Bulk update users", summary);
        return toolResult(text, summary);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ---------------------------------------------------------------------------
  // wp_bulk_create_posts
  // ---------------------------------------------------------------------------
  server.registerTool(
    "wp_bulk_create_posts",
    {
      title: "Bulk Create Posts from CSV",
      description: `Create many posts from a CSV. Required columns: title, content. Optional: status (default 'draft'), slug, excerpt, categories (comma-sep IDs), tags (comma-sep IDs), date, featured_media. Defaults to dry_run=true.

Use case: import a content calendar.`,
      inputSchema: BulkCreatePostsInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: BulkCreatePostsInput) => {
      try {
        const parsed = parseCsvFile(params.csv_path, {
          requiredColumns: ["title", "content"],
        });
        const summary: BulkSummary = {
          dry_run: params.dry_run,
          total_rows: parsed.rowCount,
          succeeded: 0,
          failed: 0,
          results: [],
        };

        for (let i = 0; i < parsed.rows.length; i++) {
          const row = parsed.rows[i]!;
          const rowIndex = i + 2;
          try {
            const payload: Record<string, unknown> = {
              title: row["title"],
              content: row["content"],
              status: cellToOptionalString(row["status"]) ?? "draft",
            };
            if (cellToOptionalString(row["slug"]) !== undefined) payload["slug"] = row["slug"];
            if (cellToOptionalString(row["excerpt"]) !== undefined) payload["excerpt"] = row["excerpt"];
            if (cellToOptionalString(row["date"]) !== undefined) payload["date"] = row["date"];
            const cats = cellToIntArray(row["categories"]);
            if (cats !== undefined) payload["categories"] = cats;
            const tags = cellToIntArray(row["tags"]);
            if (tags !== undefined) payload["tags"] = tags;
            const fm = cellToInt(row["featured_media"]);
            if (fm !== undefined) payload["featured_media"] = fm;

            if (params.dry_run) {
              summary.results.push({
                row_index: rowIndex,
                ok: true,
                message: `[dry-run] Would create post "${row["title"]}" with status ${payload["status"]}`,
              });
              summary.succeeded++;
            } else {
              const result = await makeApiRequest<{ id: number; slug: string; link: string }>(
                wpV2("posts"),
                "POST",
                undefined,
                payload
              );
              summary.results.push({
                row_index: rowIndex,
                ok: true,
                id: result.data.id,
                message: `Created post ${result.data.id} (${result.data.link})`,
              });
              summary.succeeded++;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            summary.results.push({ row_index: rowIndex, ok: false, message: msg });
            summary.failed++;
            if (params.stop_on_error) break;
          }
        }

        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(summary, null, 2)
          : summarizeMarkdown("Bulk create posts", summary);
        return toolResult(text, summary);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ---------------------------------------------------------------------------
  // wp_bulk_assign_terms
  // ---------------------------------------------------------------------------
  server.registerTool(
    "wp_bulk_assign_terms",
    {
      title: "Bulk Assign Categories/Tags to Posts from CSV",
      description: `Assign categories or tags to many posts using term NAMES (not IDs). Missing tag names are auto-created by default. Required columns: post_id, taxonomy (category|tag), term_names (comma-separated). Defaults to dry_run=true.

This REPLACES existing terms in that taxonomy on each post. To merge with existing terms, look those up first and include them in term_names.`,
      inputSchema: BulkAssignTermsInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: BulkAssignTermsInput) => {
      try {
        const parsed = parseCsvFile(params.csv_path, {
          requiredColumns: ["post_id", "taxonomy", "term_names"],
        });
        const summary: BulkSummary = {
          dry_run: params.dry_run,
          total_rows: parsed.rowCount,
          succeeded: 0,
          failed: 0,
          results: [],
        };

        // Cache of resolved term-name -> term-id, per taxonomy, to avoid
        // re-fetching the same lookup repeatedly within one bulk run.
        const termCache = new Map<string, number>(); // key: `${taxonomy}:${name.toLowerCase()}`

        async function resolveTermId(taxonomy: "categories" | "tags", name: string): Promise<number> {
          const cacheKey = `${taxonomy}:${name.toLowerCase()}`;
          if (termCache.has(cacheKey)) return termCache.get(cacheKey)!;
          // Try to find an existing term by exact name match.
          const search = await makeApiRequest<Array<{ id: number; name: string }>>(
            wpV2(taxonomy),
            "GET",
            { search: name, per_page: 100 }
          );
          const found = search.data.find((t) => t.name.toLowerCase() === name.toLowerCase());
          if (found) {
            termCache.set(cacheKey, found.id);
            return found.id;
          }
          // Not found — create if allowed.
          if (!params.auto_create_missing) {
            throw new Error(`Term "${name}" not found in ${taxonomy}, and auto_create_missing=false.`);
          }
          if (params.dry_run) {
            // Use a placeholder; real ID would be assigned on actual run.
            termCache.set(cacheKey, -1);
            return -1;
          }
          const created = await makeApiRequest<{ id: number; name: string }>(
            wpV2(taxonomy),
            "POST",
            undefined,
            { name }
          );
          termCache.set(cacheKey, created.data.id);
          return created.data.id;
        }

        for (let i = 0; i < parsed.rows.length; i++) {
          const row = parsed.rows[i]!;
          const rowIndex = i + 2;
          try {
            const postId = cellToInt(row["post_id"]);
            if (postId === undefined) throw new Error("Missing or invalid post_id.");
            const taxonomyRaw = row["taxonomy"]?.trim().toLowerCase();
            if (taxonomyRaw !== "category" && taxonomyRaw !== "tag") {
              throw new Error(`Invalid taxonomy "${row["taxonomy"]}". Must be "category" or "tag".`);
            }
            const taxonomy = taxonomyRaw === "category" ? "categories" : "tags";
            const termNames = cellToStringArray(row["term_names"]);
            if (!termNames || termNames.length === 0) {
              throw new Error("term_names is empty.");
            }

            const termIds: number[] = [];
            for (const name of termNames) {
              termIds.push(await resolveTermId(taxonomy, name));
            }

            const payload: Record<string, unknown> = {};
            payload[taxonomy] = termIds.filter((id) => id > 0); // strip placeholder -1s

            if (params.dry_run) {
              const placeholderCount = termIds.filter((id) => id === -1).length;
              summary.results.push({
                row_index: rowIndex,
                ok: true,
                id: postId,
                message: `[dry-run] Would assign ${termNames.length} ${taxonomy} to post ${postId} (${termNames.join(", ")})` +
                  (placeholderCount > 0 ? ` — ${placeholderCount} term(s) would be auto-created` : ""),
              });
              summary.succeeded++;
            } else {
              const result = await makeApiRequest<{ id: number }>(
                wpV2(`posts/${postId}`),
                "PUT",
                undefined,
                payload
              );
              summary.results.push({
                row_index: rowIndex,
                ok: true,
                id: result.data.id,
                message: `Assigned ${termNames.length} ${taxonomy} to post ${result.data.id}: ${termNames.join(", ")}`,
              });
              summary.succeeded++;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            summary.results.push({ row_index: rowIndex, ok: false, message: msg });
            summary.failed++;
            if (params.stop_on_error) break;
          }
        }

        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(summary, null, 2)
          : summarizeMarkdown("Bulk assign terms", summary);
        return toolResult(text, summary);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
