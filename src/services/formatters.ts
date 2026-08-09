/**
 * Shared formatting helpers used by every tool module.
 *
 * Goal: tool modules describe WHAT data they want; this module handles HOW to
 * shape it for MCP responses (markdown vs JSON, pagination envelopes,
 * truncation against CHARACTER_LIMIT, MCP result shape).
 */
import { CHARACTER_LIMIT } from "../constants.js";
import {
  type PaginatedResponse,
  ResponseFormat,
} from "../types.js";

/** WordPress returns rendered HTML in many fields. Strip to plain text for previews. */
export function stripHtml(html: string | undefined | null): string {
  if (!html) return "";
  // Remove script/style blocks first to avoid leaving their text content behind.
  const noScriptStyle = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  // Replace <br> and block-level closes with newlines for readability.
  const withBreaks = noScriptStyle
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n");
  // Strip all remaining tags.
  const noTags = withBreaks.replace(/<[^>]+>/g, "");
  // Decode common HTML entities.
  const decoded = noTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&hellip;/g, "...");
  return decoded.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Truncate plain text to a max char count, appending an ellipsis if shortened. */
export function truncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text || "";
  return text.slice(0, maxLen).trimEnd() + "...";
}

/** Build a paginated envelope around a page of items + total count. */
export function buildPaginated<T>(
  items: T[],
  total: number,
  offset: number
): PaginatedResponse<T> {
  const hasMore = total > offset + items.length;
  return {
    total,
    count: items.length,
    offset,
    items,
    has_more: hasMore,
    ...(hasMore ? { next_offset: offset + items.length } : {}),
  };
}

/**
 * If the JSON-stringified response exceeds CHARACTER_LIMIT, halve the items
 * array and mark the envelope as truncated. Caller is responsible for noting
 * this in markdown output too.
 */
export function enforceCharLimit<T>(
  response: PaginatedResponse<T>
): PaginatedResponse<T> {
  const initialJson = JSON.stringify(response);
  if (initialJson.length <= CHARACTER_LIMIT) return response;

  const halfLength = Math.max(1, Math.floor(response.items.length / 2));
  const truncated: PaginatedResponse<T> = {
    ...response,
    items: response.items.slice(0, halfLength),
    count: halfLength,
    truncated: true,
    truncation_message:
      `Response truncated from ${response.items.length} to ${halfLength} items ` +
      `because it exceeded ${CHARACTER_LIMIT.toLocaleString()} characters. ` +
      `Use the 'limit' parameter (smaller value) or 'offset' parameter to page through results.`,
  };
  return truncated;
}

/**
 * Standard MCP tool response shape — index-signature record for
 * structuredContent satisfies the MCP SDK type requirement.
 */
type StructuredData = { [key: string]: unknown };

/**
 * Build the standard MCP tool response shape. Includes both the text content
 * (rendered per response_format) and the structuredContent for clients that
 * support it. The cast to StructuredData appeases the SDK's strict type
 * requirement; runtime values are JSON-serialized normally.
 */
export function toolResult(
  textContent: string,
  structuredContent?: object
): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: StructuredData;
} {
  return {
    content: [{ type: "text", text: textContent }],
    ...(structuredContent !== undefined
      ? { structuredContent: structuredContent as StructuredData }
      : {}),
  };
}

/**
 * Build an error tool response that the MCP client can show to the user.
 * Setting isError: true tells the client this is a tool-level error (not a
 * protocol error) so it can render appropriately.
 */
export function toolError(
  message: string
): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

/** Render a list of items as Markdown using a per-item formatter. */
export function renderMarkdownList<T>(
  items: T[],
  title: string,
  totalCount: number,
  offset: number,
  itemFormatter: (item: T) => string,
  truncatedNote?: string
): string {
  const lines: string[] = [`# ${title}`, ""];
  if (totalCount > 0) {
    lines.push(
      `Showing **${items.length}** of **${totalCount}** total (offset ${offset}).`
    );
  } else {
    lines.push(`Showing **${items.length}** items (no total reported by WordPress).`);
  }
  if (truncatedNote) lines.push("", `> NOTE: ${truncatedNote}`);
  lines.push("");
  for (const item of items) {
    lines.push(itemFormatter(item));
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Final render step: take a paginated response and the requested format,
 * return the text content string.
 */
export function renderResponse<T>(
  response: PaginatedResponse<T>,
  format: ResponseFormat,
  title: string,
  itemFormatter: (item: T) => string
): string {
  if (format === ResponseFormat.JSON) {
    return JSON.stringify(response, null, 2);
  }
  return renderMarkdownList(
    response.items,
    title,
    response.total,
    response.offset,
    itemFormatter,
    response.truncation_message
  );
}
