/**
 * Gravity Forms tools — build, edit and read Gravity Forms over the plugin's
 * own REST API (gf/v2).
 *
 * Why this exists: on 2026-10-14 a post-concert survey could not be built,
 * because no connector could create a form and the browser fallback was
 * blocked. Jonathan: "Add form building tool to BOTH" — this is the WordPress
 * half; the Google Forms half lives in ArsNovaSingers/arsnova-google.
 *
 * Why the REST API and not Gravity Forms' official MCP server: that server
 * needs WordPress 6.9 + the Abilities API, ships every tool switched off, and
 * would be one more connector and Application Password per person. These
 * tools ride the identity each teammate already has on this connector, so
 * what they can do is exactly what their WordPress role allows. The Sub Admin
 * role (Kim, Zahnay) carries gform_full_access.
 *
 * Requirements: Gravity Forms active and its REST API enabled
 * (Forms -> Settings -> REST API). Switched on, on LIVE, 2026-09-23.
 *
 * A form is invisible to the public until it is placed on a page: create the
 * form here, then put [gravityform id="N" title="false"] in a page with
 * wp_create_page / wp_update_page. That second step is the public one.
 *
 * Field specs — the same simple shape as the Google Forms tools:
 *   { type, label, required?, description?, options?, other?, placeholder?,
 *     low?, high?, low_label?, high_label?, admin_label? }
 *   type: short_answer | paragraph | multiple_choice | checkbox | dropdown |
 *         email | phone | number | date | website | name | scale |
 *         section | page | html | hidden | consent
 *   or { raw: <Gravity Forms field object> } to send a field untouched.
 *   "scale" renders as a horizontal radio row low..high (default 0..10), with
 *   the end labels on the first and last choices.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

const GF_NS = "gf/v2";

type GfField = Record<string, unknown> & { id: number; type: string; label?: string };
type GfForm = Record<string, unknown> & { id?: number | string; title?: string; fields?: GfField[] };

// -----------------------------------------------------------------------------
// Field spec -> Gravity Forms field object
// -----------------------------------------------------------------------------

const FieldSpec = z.object({
  type: z.string().optional().describe(
    "short_answer | paragraph | multiple_choice | checkbox | dropdown | email | phone | number | date | website | name | scale | section | page | html | hidden | consent"
  ),
  label: z.string().optional().describe("The question / field label."),
  required: z.boolean().optional(),
  description: z.string().optional().describe("Help text under the label. For type 'html', the HTML to show."),
  options: z.array(z.string()).optional().describe("Choices for multiple_choice / checkbox / dropdown."),
  other: z.boolean().optional().describe("multiple_choice only: add an 'Other' choice with a text box."),
  placeholder: z.string().optional(),
  low: z.number().int().optional().describe("scale: first number (default 0)."),
  high: z.number().int().optional().describe("scale: last number (default 10)."),
  low_label: z.string().optional().describe("scale: label for the low end."),
  high_label: z.string().optional().describe("scale: label for the high end."),
  admin_label: z.string().optional().describe("Short name shown in entry lists/exports."),
  raw: z.record(z.unknown()).optional().describe("A raw Gravity Forms field object, sent as-is (id is assigned if missing)."),
}).passthrough();
type FieldSpecInput = z.infer<typeof FieldSpec>;

const TYPE_MAP: Record<string, string> = {
  short_answer: "text", text: "text", paragraph: "textarea", textarea: "textarea",
  multiple_choice: "radio", radio: "radio", checkbox: "checkbox", checkboxes: "checkbox",
  dropdown: "select", select: "select", email: "email", phone: "phone", number: "number",
  date: "date", website: "website", name: "name", scale: "radio", section: "section",
  page: "page", html: "html", hidden: "hidden", consent: "consent",
};

function choices(opts: string[]): Array<Record<string, unknown>> {
  return opts.map((o) => ({ text: o, value: o, isSelected: false, price: "" }));
}

export function toGfField(spec: FieldSpecInput, id: number): GfField {
  if (spec.raw) {
    const raw = { ...spec.raw } as GfField;
    if (raw.id === undefined || raw.id === null) raw.id = id;
    return raw;
  }
  const kind = String(spec.type ?? "").toLowerCase().trim();
  const gfType = TYPE_MAP[kind];
  if (!gfType) {
    throw new Error(`Unknown field type '${kind}'. Use one of: ${Object.keys(TYPE_MAP).join(", ")} — or { raw: ... }.`);
  }
  const f: GfField = { id, type: gfType, label: spec.label ?? "", isRequired: !!spec.required };
  if (spec.description) f.description = spec.description;
  if (spec.placeholder) f.placeholder = spec.placeholder;
  if (spec.admin_label) f.adminLabel = spec.admin_label;

  if (kind === "scale") {
    const low = spec.low ?? 0;
    const high = spec.high ?? 10;
    if (high <= low) throw new Error(`'${spec.label}': scale needs high > low.`);
    const nums: string[] = [];
    for (let n = low; n <= high; n++) nums.push(String(n));
    f.choices = nums.map((n, i) => ({
      text: i === 0 && spec.low_label ? `${n} - ${spec.low_label}`
        : i === nums.length - 1 && spec.high_label ? `${n} - ${spec.high_label}` : n,
      value: n, isSelected: false, price: "",
    }));
    f.cssClass = "gf_list_inline";
  } else if (gfType === "radio" || gfType === "select" || gfType === "checkbox") {
    const opts = spec.options ?? [];
    if (!opts.length) throw new Error(`'${spec.label}': ${kind} needs 'options'.`);
    f.choices = choices(opts);
    if (gfType === "radio" && spec.other) f.enableOtherChoice = true;
    if (gfType === "checkbox") {
      // Checkbox fields store one input per choice; GF does not create them for us.
      // GF skips input numbers ending in 0 (x.10, x.20) — mirror that.
      const inputs: Array<Record<string, unknown>> = [];
      let n = 1;
      for (const o of opts) {
        if (n % 10 === 0) n++;
        inputs.push({ id: `${id}.${n}`, label: o, name: "" });
        n++;
      }
      f.inputs = inputs;
    }
  } else if (gfType === "name") {
    f.nameFormat = "advanced";
    f.inputs = [
      { id: `${id}.2`, label: "Prefix", name: "", isHidden: true },
      { id: `${id}.3`, label: "First", name: "" },
      { id: `${id}.4`, label: "Middle", name: "", isHidden: true },
      { id: `${id}.6`, label: "Last", name: "" },
      { id: `${id}.8`, label: "Suffix", name: "", isHidden: true },
    ];
  } else if (gfType === "html") {
    f.content = spec.description ?? "";
    delete f.description;
  } else if (gfType === "consent") {
    f.checkboxLabel = spec.description ?? spec.label ?? "I agree";
    f.inputs = [
      { id: `${id}.1`, label: "Consent", name: "" },
      { id: `${id}.2`, label: "Text", name: "", isHidden: true },
      { id: `${id}.3`, label: "Description", name: "", isHidden: true },
    ];
  } else if (gfType === "phone") {
    f.phoneFormat = "standard";
  }
  return f;
}

function nextFieldId(fields: GfField[] | undefined): number {
  let max = 0;
  for (const f of fields ?? []) {
    const n = Number(f.id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function summarize(form: GfForm): Record<string, unknown> {
  return {
    id: form.id,
    title: form.title,
    description: form.description,
    is_active: form.is_active,
    is_trash: form.is_trash,
    button: (form.button as { text?: string } | undefined)?.text,
    shortcode: form.id ? `[gravityform id="${form.id}" title="false"]` : undefined,
    fields: (form.fields ?? []).map((f) => ({
      id: f.id,
      type: f.type,
      label: f.label,
      required: f.isRequired ?? false,
      ...(Array.isArray(f.choices) ? { options: (f.choices as Array<{ text?: string }>).map((c) => c.text) } : {}),
    })),
  };
}

function fieldLines(form: GfForm): string {
  return (form.fields ?? [])
    .map((f) => `${f.id}. [${f.type}] ${f.label ?? ""}${f.isRequired ? " *" : ""}`)
    .join("\n");
}

async function getForm(formId: number): Promise<GfForm> {
  const r = await makeApiRequest<GfForm>(`${GF_NS}/forms/${formId}`, "GET");
  return r.data;
}

/** GF answers a write with the saved form (or {id}); always re-read so callers see the truth. */
async function putForm(formId: number, form: GfForm): Promise<GfForm> {
  await makeApiRequest<GfForm>(`${GF_NS}/forms/${formId}`, "PUT", undefined, form as Record<string, unknown>);
  return getForm(formId);
}

type GfEntry = Record<string, unknown> & { id?: number | string; form_id?: number | string };

async function getEntry(entryId: number): Promise<GfEntry> {
  const r = await makeApiRequest<GfEntry>(`${GF_NS}/entries/${entryId}`, "GET");
  return r.data;
}

/** Field id/label -> the entry keys it owns ("5", or "2.1".."2.6" for a multi-input field). */
function fieldKeys(form: GfForm): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of form.fields ?? []) {
    const inputs = (f as { inputs?: Array<{ id: string | number }> }).inputs;
    const keys = Array.isArray(inputs) && inputs.length ? inputs.map((i) => String(i.id)) : [String(f.id)];
    out.set(String(f.id), keys);
    for (const k of keys) out.set(k, [k]);
    if (f.label) out.set(String(f.label), keys);
    if (f.adminLabel) out.set(String(f.adminLabel), keys);
  }
  return out;
}

function labelledAnswers(form: GfForm, e: GfEntry): Record<string, string> {
  const labels = new Map<string, string>();
  for (const f of form.fields ?? []) labels.set(String(f.id), String(f.adminLabel || f.label || f.id));
  const answers: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) {
    const m = /^(\d+)(?:\.\d+)?$/.exec(k);
    if (!m || v === "" || v === null || v === undefined) continue;
    const label = labels.get(m[1]) ?? k;
    answers[label] = answers[label] ? `${answers[label]}, ${String(v)}` : String(v);
  }
  return answers;
}

function render(form: GfForm, fmt: ResponseFormat | undefined, heading: string) {
  const s = summarize(form);
  const text = fmt === ResponseFormat.JSON
    ? JSON.stringify(s, null, 2)
    : `# ${heading}: ${form.title} (id ${form.id})\n\nShortcode: \`${s.shortcode}\`\n\n${fieldLines(form)}`;
  return toolResult(text, s);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

const ListFormsSchema = z.object({
  include_inactive: z.boolean().default(true),
  response_format: ResponseFormatField,
}).strict();

const GetFormSchema = z.object({
  form_id: z.number().int().positive(),
  raw: z.boolean().default(false).describe("Return the full Gravity Forms form object."),
  response_format: ResponseFormatField,
}).strict();

const CreateFormSchema = z.object({
  title: z.string().min(1).describe("Form title (shown to respondents unless the shortcode sets title=false)."),
  description: z.string().optional(),
  fields: z.array(FieldSpec).default([]).describe("Questions, in order. See the module notes for the spec."),
  button_text: z.string().optional().describe("Submit button text. Default 'Submit'."),
  confirmation_message: z.string().optional().describe("Message shown after submitting. Default: 'Thanks for contacting us!...'."),
  notify_email: z.string().optional().describe("If set, an admin notification email goes here on every submission."),
  is_active: z.boolean().default(true),
  response_format: ResponseFormatField,
}).strict();

const AddFieldsSchema = z.object({
  form_id: z.number().int().positive(),
  fields: z.array(FieldSpec).min(1),
  position: z.number().int().min(0).optional().describe("Insert at this position (0 = top). Default: append."),
  response_format: ResponseFormatField,
}).strict();

const UpdateFormSchema = z.object({
  form_id: z.number().int().positive(),
  title: z.string().optional(),
  description: z.string().optional(),
  is_active: z.boolean().optional(),
  button_text: z.string().optional(),
  remove_field_ids: z.array(z.number().int()).optional().describe("Delete these fields (by field id)."),
  update_fields: z.array(z.record(z.unknown())).optional().describe(
    "Patch existing fields: each object needs 'id' plus the Gravity Forms properties to change, e.g. { id: 3, label: 'New label', isRequired: true }."
  ),
  form_patch: z.record(z.unknown()).optional().describe(
    "Escape hatch: top-level Gravity Forms form properties merged onto the form as-is (confirmations, notifications, limitEntries, scheduleForm, ...)."
  ),
  response_format: ResponseFormatField,
}).strict();

const DeleteFormSchema = z.object({
  form_id: z.number().int().positive(),
  force: z.boolean().default(false).describe("true = delete permanently. Default false = move to Trash (restorable)."),
}).strict();

const ListEntriesSchema = z.object({
  form_id: z.number().int().positive(),
  page_size: z.number().int().min(1).max(200).default(50),
  page: z.number().int().min(1).default(1),
  status: z.enum(["active", "spam", "trash"]).default("active"),
  response_format: ResponseFormatField,
}).strict();

const GetEntrySchema = z.object({
  entry_id: z.number().int().positive(),
  response_format: ResponseFormatField,
}).strict();

const UpdateEntrySchema = z.object({
  entry_id: z.number().int().positive(),
  values: z.record(z.string()).optional().describe(
    "Answers to change, keyed by field id (\"5\", or \"2.3\" for one part of a name/address/checkbox field) or by the field's exact label / admin label. Only these change; everything else on the entry is kept."
  ),
  status: z.enum(["active", "spam", "trash"]).optional().describe("Move the entry to active / spam / trash."),
  is_starred: z.boolean().optional(),
  is_read: z.boolean().optional(),
}).strict();

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export function registerGravityFormsTools(server: McpServer): void {
  server.registerTool(
    "gf_list_forms",
    {
      title: "List Gravity Forms",
      description: "List every Gravity Form on the site with its id, title, active state and entry count. Requires Gravity Forms with its REST API enabled.",
      inputSchema: ListFormsSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (p: z.infer<typeof ListFormsSchema>) => {
      try {
        const r = await makeApiRequest<Record<string, Record<string, unknown>> | Array<Record<string, unknown>>>(
          `${GF_NS}/forms`, "GET"
        );
        const all = Array.isArray(r.data) ? r.data : Object.values(r.data ?? {});
        const list = p.include_inactive ? all : all.filter((f) => String(f.is_active) !== "0" && f.is_active !== false);
        const items = list.map((f) => ({
          id: f.id, title: f.title, is_active: f.is_active, entries: f.entries,
        }));
        const text = p.response_format === ResponseFormat.JSON
          ? JSON.stringify(items, null, 2)
          : `# Gravity Forms (${items.length})\n\n` +
            items.map((f) => `- ${f.id}: ${f.title}${String(f.is_active) === "0" || f.is_active === false ? " [inactive]" : ""} · ${f.entries ?? 0} entries`).join("\n");
        return toolResult(text, { count: items.length, items });
      } catch (e) {
        return toolError(errMsg(e));
      }
    }
  );

  server.registerTool(
    "gf_get_form",
    {
      title: "Get a Gravity Form",
      description: "Read one Gravity Form: title, description, its embed shortcode, and every field with id, type, label and choices. raw=true returns the full form object.",
      inputSchema: GetFormSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (p: z.infer<typeof GetFormSchema>) => {
      try {
        const form = await getForm(p.form_id);
        if (p.raw) return toolResult(JSON.stringify(form, null, 2), form);
        return render(form, p.response_format, "Form");
      } catch (e) {
        return toolError(errMsg(e));
      }
    }
  );

  server.registerTool(
    "gf_create_form",
    {
      title: "Create a Gravity Form",
      description: `Create a complete Gravity Form in one call — title, description, every question, submit button, confirmation message and an optional admin notification email.

Field spec: { type, label, required?, description?, options?, other?, placeholder?, low?, high?, low_label?, high_label? }
  type: short_answer | paragraph | multiple_choice | checkbox | dropdown | email | phone | number | date | website | name | scale | section | page | html | hidden | consent
  or { raw: <Gravity Forms field object> }.

The form is NOT public until placed on a page: put the returned shortcode in a page with wp_create_page / wp_update_page.

Returns the saved form: id, shortcode and numbered fields.`,
      inputSchema: CreateFormSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (p: z.infer<typeof CreateFormSchema>) => {
      try {
        const fields = p.fields.map((s, i) => toGfField(s, i + 1));
        const form: GfForm = {
          title: p.title,
          description: p.description ?? "",
          labelPlacement: "top_label",
          descriptionPlacement: "below",
          button: { type: "text", text: p.button_text ?? "Submit", imageUrl: "" },
          fields,
          is_active: p.is_active,
        };
        if (p.confirmation_message) {
          form.confirmations = [{
            id: "default", name: "Default Confirmation", isDefault: true,
            type: "message", message: p.confirmation_message,
          }];
        }
        if (p.notify_email) {
          form.notifications = [{
            id: "admin", name: "Admin Notification", isActive: true, event: "form_submission",
            to: p.notify_email, toType: "email",
            subject: `New submission: ${p.title}`, message: "{all_fields}",
          }];
        }
        const r = await makeApiRequest<GfForm | { id?: number }>(`${GF_NS}/forms`, "POST", undefined, form as Record<string, unknown>);
        const newId = Number((r.data as { id?: number }).id);
        if (!Number.isFinite(newId) || newId <= 0) {
          return toolError(`Gravity Forms did not return a form id. Response: ${JSON.stringify(r.data).slice(0, 500)}`);
        }
        return render(await getForm(newId), p.response_format, "Created form");
      } catch (e) {
        return toolError(errMsg(e));
      }
    }
  );

  server.registerTool(
    "gf_add_fields",
    {
      title: "Add Fields to a Gravity Form",
      description: "Add questions to an existing Gravity Form, using the same field specs as gf_create_form. New fields get fresh ids (existing entries keep their data). position = insert point (0 = top); default appends.",
      inputSchema: AddFieldsSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (p: z.infer<typeof AddFieldsSchema>) => {
      try {
        const form = await getForm(p.form_id);
        const existing = form.fields ?? [];
        let nid = nextFieldId(existing);
        const added = p.fields.map((s) => toGfField(s, nid++));
        const at = p.position === undefined ? existing.length : Math.min(p.position, existing.length);
        form.fields = [...existing.slice(0, at), ...added, ...existing.slice(at)];
        return render(await putForm(p.form_id, form), p.response_format, "Updated form");
      } catch (e) {
        return toolError(errMsg(e));
      }
    }
  );

  server.registerTool(
    "gf_update_form",
    {
      title: "Update a Gravity Form",
      description: `Edit an existing Gravity Form: title, description, active state, button text; delete fields by id; patch fields in place; or merge any raw form properties (confirmations, notifications, limits, scheduling).

Deleting a field also hides that field's answers in existing entries — check gf_list_entries first on a form that has responses.`,
      inputSchema: UpdateFormSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (p: z.infer<typeof UpdateFormSchema>) => {
      try {
        const form = await getForm(p.form_id);
        if (p.title !== undefined) form.title = p.title;
        if (p.description !== undefined) form.description = p.description;
        if (p.is_active !== undefined) form.is_active = p.is_active;
        if (p.button_text !== undefined) {
          form.button = { ...((form.button as Record<string, unknown>) ?? { type: "text" }), text: p.button_text };
        }
        let fields = form.fields ?? [];
        if (p.remove_field_ids?.length) {
          const drop = new Set(p.remove_field_ids.map(Number));
          fields = fields.filter((f) => !drop.has(Number(f.id)));
        }
        if (p.update_fields?.length) {
          for (const patch of p.update_fields) {
            const idx = fields.findIndex((f) => Number(f.id) === Number(patch.id));
            if (idx < 0) return toolError(`No field with id ${String(patch.id)} on form ${p.form_id}.`);
            fields[idx] = { ...fields[idx], ...patch, id: fields[idx].id } as GfField;
          }
        }
        form.fields = fields;
        if (p.form_patch) Object.assign(form, p.form_patch, { id: form.id });
        return render(await putForm(p.form_id, form), p.response_format, "Updated form");
      } catch (e) {
        return toolError(errMsg(e));
      }
    }
  );

  server.registerTool(
    "gf_delete_form",
    {
      title: "Delete (Trash) a Gravity Form",
      description: "Move a Gravity Form to the Trash (restorable from Forms -> Trash). force=true deletes it permanently together with all its entries — that cannot be undone.",
      inputSchema: DeleteFormSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (p: z.infer<typeof DeleteFormSchema>) => {
      try {
        const r = await makeApiRequest<Record<string, unknown>>(
          `${GF_NS}/forms/${p.form_id}`, "DELETE", p.force ? { force: 1 } : undefined
        );
        return toolResult(
          p.force ? `Form ${p.form_id} permanently deleted.` : `Form ${p.form_id} moved to Trash (restorable).`,
          r.data
        );
      } catch (e) {
        return toolError(errMsg(e));
      }
    }
  );

  server.registerTool(
    "gf_list_entries",
    {
      title: "List Gravity Form Entries",
      description: "Read submissions for a form, newest first, with each answer labelled by its field label rather than its numeric id. Checkbox and name sub-inputs are joined.",
      inputSchema: ListEntriesSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (p: z.infer<typeof ListEntriesSchema>) => {
      try {
        const form = await getForm(p.form_id);
        const labels = new Map<string, string>();
        for (const f of form.fields ?? []) labels.set(String(f.id), String(f.adminLabel || f.label || f.id));
        const r = await makeApiRequest<{ total_count?: number | string; entries?: Array<Record<string, unknown>> }>(
          `${GF_NS}/forms/${p.form_id}/entries`, "GET",
          {
            "paging[page_size]": p.page_size,
            "paging[current_page]": p.page,
            "search": JSON.stringify({ status: p.status }),
            "sorting[key]": "date_created",
            "sorting[direction]": "DESC",
          }
        );
        const entries = (r.data.entries ?? []).map((e) => {
          const answers: Record<string, string> = {};
          for (const [k, v] of Object.entries(e)) {
            const m = /^(\d+)(?:\.\d+)?$/.exec(k);
            if (!m || v === "" || v === null || v === undefined) continue;
            const label = labels.get(m[1]) ?? k;
            answers[label] = answers[label] ? `${answers[label]}, ${String(v)}` : String(v);
          }
          return { id: e.id, created: e.date_created, source_url: e.source_url, answers };
        });
        const total = Number(r.data.total_count ?? entries.length);
        const text = p.response_format === ResponseFormat.JSON
          ? JSON.stringify({ total, entries }, null, 2)
          : `# Entries for "${form.title}" (${entries.length} of ${total})\n\n` +
            entries.map((e) => `## Entry ${e.id} · ${e.created}\n` +
              Object.entries(e.answers).map(([k, v]) => `- **${k}:** ${v}`).join("\n")).join("\n\n");
        return toolResult(text, { total, page: p.page, entries });
      } catch (e) {
        return toolError(errMsg(e));
      }
    }
  );
  server.registerTool(
    "gf_get_entry",
    {
      title: "Get One Gravity Form Entry",
      description: "Read one submission by entry id: its answers labelled by field label, plus its properties (form, date, status, read/starred, source page).",
      inputSchema: GetEntrySchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (p: z.infer<typeof GetEntrySchema>) => {
      try {
        const e = await getEntry(p.entry_id);
        const form = await getForm(Number(e.form_id));
        const answers = labelledAnswers(form, e);
        const props = {
          id: e.id, form_id: e.form_id, form_title: form.title, date_created: e.date_created, date_updated: e.date_updated,
          status: e.status, is_read: e.is_read, is_starred: e.is_starred, source_url: e.source_url, created_by: e.created_by,
        };
        const text = p.response_format === ResponseFormat.JSON
          ? JSON.stringify({ ...props, answers }, null, 2)
          : `# Entry ${e.id} · "${form.title}" · ${e.date_created} · ${e.status}\n\n` +
            Object.entries(answers).map(([k, v]) => `- **${k}:** ${v}`).join("\n");
        return toolResult(text, { ...props, answers });
      } catch (e) {
        return toolError(errMsg(e));
      }
    }
  );

  server.registerTool(
    "gf_update_entry",
    {
      title: "Update a Gravity Form Entry",
      description: `Change answers on one submission, or move it to spam / trash, or mark it read / starred. Only what you pass changes.

Why this reads the entry first: in Gravity Forms 3.1.3, PUT gf/v2/entries/{id} hands the body to GFAPI::update_entry(), which DELETES every field value the body leaves out and resets date_created, IP, source page, read/starred and payment properties to defaults (verified in includes/api.php on the server, 2026-10-21). So this tool reads the full entry, merges your changes onto it and sends the whole entry back.

values are keyed by field id ("5", "2.3") or the field's exact label / admin label. A label that matches a multi-input field (name, address, checkbox) must instead name the sub-input id, e.g. "2.3". Unknown keys are refused rather than guessed.`,
      inputSchema: UpdateEntrySchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (p: z.infer<typeof UpdateEntrySchema>) => {
      try {
        const current = await getEntry(p.entry_id);
        const form = await getForm(Number(current.form_id));
        const keys = fieldKeys(form);
        const merged: GfEntry = { ...current };
        const changed: Record<string, { from: unknown; to: unknown }> = {};
        for (const [k, v] of Object.entries(p.values ?? {})) {
          const target = keys.get(k);
          if (!target) return toolError(`No field "${k}" on form ${current.form_id} ("${form.title}"). Use a field id from gf_get_form, or its exact label.`);
          if (target.length !== 1) return toolError(`"${k}" is a multi-input field; name the part instead (one of ${target.join(", ")}).`);
          changed[target[0]] = { from: current[target[0]] ?? "", to: v };
          merged[target[0]] = v;
        }
        if (p.status !== undefined) { changed.status = { from: current.status, to: p.status }; merged.status = p.status; }
        if (p.is_starred !== undefined) { changed.is_starred = { from: current.is_starred, to: p.is_starred ? 1 : 0 }; merged.is_starred = p.is_starred ? 1 : 0; }
        if (p.is_read !== undefined) { changed.is_read = { from: current.is_read, to: p.is_read ? 1 : 0 }; merged.is_read = p.is_read ? 1 : 0; }
        if (!Object.keys(changed).length) return toolError("Nothing to change: pass values, status, is_starred or is_read.");
        await makeApiRequest<GfEntry>(`${GF_NS}/entries/${p.entry_id}`, "PUT", undefined, merged as Record<string, unknown>);
        const after = await getEntry(p.entry_id);
        const lost = Object.keys(current).filter((k) => /^\d+(\.\d+)?$/.test(k) && !(k in changed) && String(current[k] ?? "") !== "" && String(after[k] ?? "") !== String(current[k]));
        const text = `Entry ${p.entry_id} updated.\n` +
          Object.entries(changed).map(([k, c]) => `- ${k}: "${String(c.from)}" -> "${String(c.to)}"`).join("\n") +
          (lost.length ? `\n\nWARNING: these other values changed unexpectedly: ${lost.join(", ")}` : "");
        return toolResult(text, { entry_id: p.entry_id, changed, unexpected: lost });
      } catch (e) {
        return toolError(errMsg(e));
      }
    }
  );
}
