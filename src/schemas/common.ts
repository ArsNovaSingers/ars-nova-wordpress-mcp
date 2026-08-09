/**
 * Common Zod schemas reused across multiple tool modules.
 */
import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../constants.js";
import { ResponseFormat } from "../types.js";

/** Pagination params (limit + offset) — composed into list-tool input schemas. */
export const PaginationSchema = z.object({
  limit: z.number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe(`Maximum results to return (1-${MAX_PAGE_SIZE}). Default ${DEFAULT_PAGE_SIZE}.`),
  offset: z.number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of results to skip for pagination. Default 0."),
});

/** Response format selector — composed into every tool input schema. */
export const ResponseFormatField = z.nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' for human-readable, 'json' for machine-readable.");

/** Common content-status filter for posts/pages. */
export const ContentStatusEnum = z.enum([
  "publish",
  "future",
  "draft",
  "pending",
  "private",
  "trash",
  "any",
]);

/** Order direction. */
export const OrderEnum = z.enum(["asc", "desc"]);

/** orderby for content endpoints. */
export const ContentOrderByEnum = z.enum([
  "date",
  "modified",
  "id",
  "title",
  "slug",
  "menu_order",
  "include",
  "author",
  "relevance",
]);
