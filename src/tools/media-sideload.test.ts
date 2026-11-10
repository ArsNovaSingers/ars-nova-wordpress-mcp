/**
 * INFRA-18: wp_upload_media source handling. Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { formatSideloadMarkdown, planUpload, pickSource, SIDELOAD_MAX_BYTES } from "./media-sideload.js";

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const noRead = () => { throw new Error("should not read"); };
const reads = (buf: Buffer) => () => buf;

test("pickSource needs exactly one", () => {
  assert.deepEqual(pickSource({}), []);
  assert.deepEqual(pickSource({ source_url: "https://a/b.jpg", drive_file_id: "x" }), ["source_url", "drive_file_id"]);
  assert.equal(pickSource({ drive_file_id: "x" }), "drive_file_id");
  assert.deepEqual(pickSource({ drive_file_id: "  " }), []);
});

test("no source and two sources are errors", () => {
  assert.equal(planUpload({}, noRead).kind, "error");
  const two = planUpload({ source_url: "https://a/b.jpg", file_path: "/x.jpg" }, noRead);
  assert.equal(two.kind, "error");
  assert.match((two as { message: string }).message, /file_path \+ source_url/);
});

test("drive_file_id goes to sideload with every option", () => {
  const p = planUpload({
    drive_file_id: "1Fwtwx-PXrdyeoOeD_AujqSoOnI9h_0Wz",
    title: "Banner", alt_text: "Pines", caption: "Cap", description: "D",
    post: 10, set_featured_on: [10, 11], confirm_production: true,
  }, noRead);
  assert.equal(p.kind, "sideload");
  assert.deepEqual((p as { body: unknown }).body, {
    drive_file_id: "1Fwtwx-PXrdyeoOeD_AujqSoOnI9h_0Wz",
    title: "Banner", alt_text: "Pines", caption: "Cap", description: "D",
    attach_to_post: 10, set_featured_on: [10, 11], confirm_production: true,
  });
});

test("post and attach_to_post must agree", () => {
  assert.equal(planUpload({ drive_file_id: "x", post: 1, attach_to_post: 2 }, noRead).kind, "error");
  assert.equal(planUpload({ drive_file_id: "x", post: 2, attach_to_post: 2 }, noRead).kind, "sideload");
});

test("source_url passes through", () => {
  const p = planUpload({ source_url: " https://cdn.example.com/a.png " }, noRead);
  assert.equal(p.kind, "sideload");
  assert.equal((p as unknown as { body: { source_url: string } }).body.source_url, "https://cdn.example.com/a.png");
});

test("base64 needs filename and sha256", () => {
  assert.equal(planUpload({ base64_content: "AAAA" }, noRead).kind, "error");
  const noSha = planUpload({ base64_content: "AAAA", filename: "a.gif" }, noRead);
  assert.equal(noSha.kind, "error");
  assert.match((noSha as { message: string }).message, /sha256/);
  const ok = planUpload({ base64_content: "AAAA", filename: "a.gif", sha256: "a".repeat(64) }, noRead);
  assert.equal(ok.kind, "sideload");
  assert.equal((ok as unknown as { body: { sha256: string } }).body.sha256, "a".repeat(64));
});

test("file_path image goes through sideload with a hash of the bytes read", () => {
  const p = planUpload({ file_path: "/data/JBP banner.JPG", set_featured_on: [5], sha256: "f".repeat(64) }, reads(JPG));
  assert.equal(p.kind, "sideload");
  const body = (p as { body: Record<string, unknown> }).body;
  assert.equal(body.base64_content, JPG.toString("base64"));
  assert.equal(body.filename, "JBP banner.JPG");
  assert.equal(body.sha256, createHash("sha256").update(JPG).digest("hex"), "the connector's own hash wins");
  assert.deepEqual(body.set_featured_on, [5]);
});

test("file_path video keeps the legacy upload, but refuses set_featured_on", () => {
  assert.deepEqual(planUpload({ file_path: "/data/clip.mp4" }, reads(JPG)), { kind: "legacy", filePath: "/data/clip.mp4" });
  assert.equal(planUpload({ file_path: "/data/clip.mp4", set_featured_on: [1] }, reads(JPG)).kind, "error");
});

test("file_path over 20 MB keeps the legacy upload", () => {
  const big = Buffer.alloc(SIDELOAD_MAX_BYTES + 1);
  assert.equal(planUpload({ file_path: "/data/huge.jpg" }, reads(big)).kind, "legacy");
});

test("unreadable file_path explains the Cloud Run host", () => {
  const p = planUpload({ file_path: "H:\\Shared drives\\x.jpg" }, () => { throw new Error("ENOENT"); });
  assert.equal(p.kind, "error");
  assert.match((p as { message: string }).message, /drive_file_id/);
});

test("markdown names the site, sizes and featured posts", () => {
  const md = formatSideloadMarkdown({
    ok: true, id: 42, source_url: "https://stg/u/a.jpg", mime: "image/jpeg", filename: "a.jpg", bytes: 10,
    width: 1440, height: 560, sizes: { medium: { url: "https://stg/u/a-300.jpg", width: 300, height: 117 } },
    featured_on: [{ post_id: 7, ok: true }, { post_id: 8, ok: false }], site: "https://stg", is_production: false,
  }, "a.jpg");
  assert.match(md, /ID 42/);
  assert.match(md, /1440 x 560/);
  assert.match(md, /medium: 300x117/);
  assert.match(md, /7, 8 \(FAILED\)/);
});
