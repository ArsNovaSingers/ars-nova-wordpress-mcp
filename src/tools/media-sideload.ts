/**
 * wp_upload_media -> POST ans-ops/v1/media/sideload (INFRA-18).
 *
 * The hosted connector runs on Cloud Run, so a file_path can only ever name a
 * file inside its own container. These helpers let wp_upload_media take a
 * source_url, a Google Drive file id or base64 bytes instead, and hand them to
 * the site's ars-nova-media plugin (1.2.0+), which fetches, checks and imports
 * the file as a real Media Library attachment with every size generated.
 *
 * Pure functions only, so they can be tested without a site.
 */
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";

export const SIDELOAD_ROUTE = "ans-ops/v1/media/sideload";
export const SIDELOAD_MAX_BYTES = 20 * 1024 * 1024;

/** Extensions the sideload route accepts. Anything else with file_path keeps the old wp/v2 upload. */
export const SIDELOAD_EXTS = new Set([".jpg", ".jpeg", ".jpe", ".png", ".webp", ".gif", ".svg", ".pdf"]);

export interface SideloadParams {
  file_path?: string;
  source_url?: string;
  drive_file_id?: string;
  base64_content?: string;
  filename?: string;
  sha256?: string;
  title?: string;
  alt_text?: string;
  caption?: string;
  description?: string;
  post?: number;
  attach_to_post?: number;
  set_featured_on?: number[];
  confirm_production?: boolean;
}

export type UploadPlan =
  | { kind: "sideload"; body: Record<string, unknown>; label: string }
  | { kind: "legacy"; filePath: string }
  | { kind: "error"; message: string };

/** Which single source was given, or an error message. */
export function pickSource(p: SideloadParams): "file_path" | "source_url" | "drive_file_id" | "base64_content" | string[] {
  const given = (["file_path", "source_url", "drive_file_id", "base64_content"] as const).filter(
    (k) => typeof p[k] === "string" && (p[k] as string).trim() !== ""
  );
  return given.length === 1 ? given[0] : [...given];
}

function optionalFields(p: SideloadParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.title) out.title = p.title;
  if (p.alt_text !== undefined) out.alt_text = p.alt_text;
  if (p.caption !== undefined) out.caption = p.caption;
  if (p.description !== undefined) out.description = p.description;
  const attach = p.attach_to_post ?? p.post;
  if (attach !== undefined && attach > 0) out.attach_to_post = attach;
  if (p.set_featured_on && p.set_featured_on.length > 0) out.set_featured_on = p.set_featured_on;
  if (p.confirm_production !== undefined) out.confirm_production = p.confirm_production;
  if (p.sha256) out.sha256 = p.sha256;
  return out;
}

/**
 * Decide how to upload. `readFile` is injected so tests need no disk.
 *
 * file_path: read on the connector host. Accepted types under 20 MB go through
 * the sideload route as base64 with a sha256 the connector computes from the
 * bytes it read, so set_featured_on works the same way for every source. Other
 * files (video, audio, large files) keep the original wp/v2 multipart upload.
 */
export function planUpload(p: SideloadParams, readFile: (path: string) => Buffer): UploadPlan {
  const source = pickSource(p);
  if (Array.isArray(source)) {
    return {
      kind: "error",
      message: source.length === 0
        ? "Provide one source: source_url, drive_file_id, base64_content (+ filename and sha256), or file_path."
        : `Provide exactly one source, not ${source.join(" + ")}.`,
    };
  }
  if (p.attach_to_post !== undefined && p.post !== undefined && p.attach_to_post !== p.post) {
    return { kind: "error", message: "post and attach_to_post disagree. Pass just attach_to_post." };
  }

  const extra = optionalFields(p);

  if (source === "source_url") {
    return { kind: "sideload", label: p.source_url!, body: { source_url: p.source_url!.trim(), ...(p.filename ? { filename: p.filename } : {}), ...extra } };
  }
  if (source === "drive_file_id") {
    return { kind: "sideload", label: `Drive file ${p.drive_file_id}`, body: { drive_file_id: p.drive_file_id!.trim(), ...(p.filename ? { filename: p.filename } : {}), ...extra } };
  }
  if (source === "base64_content") {
    if (!p.filename) return { kind: "error", message: "base64_content needs filename (with its extension)." };
    if (!p.sha256) {
      return {
        kind: "error",
        message: "base64_content needs sha256 of the ORIGINAL file. Base64 relayed through a conversation can arrive silently truncated and still look like a valid image. Prefer drive_file_id or source_url.",
      };
    }
    return { kind: "sideload", label: p.filename, body: { base64_content: p.base64_content, filename: p.filename, ...extra } };
  }

  // file_path
  const filePath = p.file_path!;
  const ext = extname(filePath).toLowerCase();
  let buf: Buffer;
  try {
    buf = readFile(filePath);
  } catch (e) {
    return {
      kind: "error",
      message:
        `Could not read file at '${filePath}': ${e instanceof Error ? e.message : String(e)}. ` +
        "file_path is read on the connector's own host (Cloud Run for the hosted connector), never your PC. " +
        "Use drive_file_id or source_url instead.",
    };
  }
  if (!SIDELOAD_EXTS.has(ext) || buf.length > SIDELOAD_MAX_BYTES) {
    if (p.set_featured_on && p.set_featured_on.length > 0) {
      return { kind: "error", message: "set_featured_on only works for jpeg/png/webp/gif/svg/pdf files up to 20 MB. Upload first, then use wp_set_featured_image." };
    }
    return { kind: "legacy", filePath };
  }
  return {
    kind: "sideload",
    label: basename(filePath),
    body: {
      base64_content: buf.toString("base64"),
      filename: p.filename || basename(filePath),
      ...extra,
      // Computed from the bytes we actually read: this is the honest hash.
      sha256: createHash("sha256").update(buf).digest("hex"),
    },
  };
}

export interface SideloadResult {
  ok: boolean;
  id: number;
  source_url: string;
  mime?: string;
  filename?: string;
  width?: number | null;
  height?: number | null;
  sizes?: Record<string, { url: string | null; width: number | null; height: number | null }>;
  bytes?: number;
  sha256?: string;
  attached_to?: number;
  alt_text?: string;
  featured_on?: Array<{ post_id: number; ok: boolean }>;
  site?: string;
  is_production?: boolean;
}

export function formatSideloadMarkdown(r: SideloadResult, label: string): string {
  const lines = [
    `# Uploaded ${label} (ID ${r.id})`,
    "",
    `- **Site:** ${r.site ?? "?"}${r.is_production ? " (LIVE)" : ""}`,
    `- **URL:** ${r.source_url}`,
    `- **File:** ${r.filename ?? "?"} (${r.mime ?? "?"}, ${r.bytes ?? "?"} bytes)`,
  ];
  if (r.width && r.height) lines.push(`- **Dimensions:** ${r.width} x ${r.height}`);
  if (r.alt_text) lines.push(`- **Alt text:** ${r.alt_text}`);
  if (r.attached_to) lines.push(`- **Attached to:** post ${r.attached_to}`);
  if (r.featured_on && r.featured_on.length > 0) {
    lines.push(`- **Featured image on:** ${r.featured_on.map((f) => `${f.post_id}${f.ok ? "" : " (FAILED)"}`).join(", ")}`);
  }
  const sizes = Object.entries(r.sizes ?? {});
  if (sizes.length > 0) {
    lines.push("", "## Sizes");
    for (const [name, s] of sizes) lines.push(`- ${name}: ${s.width}x${s.height} ${s.url ?? ""}`);
  }
  return lines.join("\n");
}
