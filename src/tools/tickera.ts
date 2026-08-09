/**
 * Tickera tools — create & list Tickera events and Bridge ticket-type products.
 *
 * These call the companion WP plugin "Ars Nova Ticketing Bridge", which exposes
 * admin-only REST routes under /wp-json/ars-nova/v1/tickera/*. The plugin writes
 * the same post + meta that the Tickera + WooCommerce Bridge admin UI writes:
 *   - Event  = a `tc_events` post (meta: event_date_time, event_end_date_time, event_location)
 *   - Ticket = a WooCommerce product + meta (_ticket=yes, event_name=<event id>,
 *              ticket_template=<id>, _ticket_availability=open_ended) + WC price/stock.
 *
 * Requires the companion plugin to be active on the target site. If a call 404s,
 * the plugin isn't installed/active yet.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

const TB_NS = "ars-nova/v1";
function tb(path: string): string {
  return `${TB_NS}/${path.replace(/^\/+/, "")}`;
}

export function registerTickeraTools(server: McpServer): void {

  // ─── tickera_status ────────────────────────────────────────────────
  server.registerTool(
    "tickera_status",
    {
      title: "Tickera Bridge Status",
      description: `Check that the Ars Nova Ticketing Bridge plugin is active and that WooCommerce,
Tickera, and the Bridge for WooCommerce are all present. Returns the default
ticket-template ID. Call this before creating events/tickets.`,
      inputSchema: { response_format: ResponseFormatField },
      annotations: { readOnlyHint: true },
    },
    async (params: { response_format?: ResponseFormat }) => {
      try {
        const r = await makeApiRequest<Record<string, unknown>>(tb("tickera/status"));
        return toolResult(JSON.stringify(r.data, null, 2), r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── tickera_list_events ───────────────────────────────────────────
  server.registerTool(
    "tickera_list_events",
    {
      title: "List Tickera Events",
      description: `List all Tickera events (tc_events) with their date, location, status, and any
linked ticket-type products.`,
      inputSchema: { response_format: ResponseFormatField },
      annotations: { readOnlyHint: true },
    },
    async (params: { response_format?: ResponseFormat }) => {
      try {
        const r = await makeApiRequest<Record<string, unknown>>(tb("tickera/events"));
        return toolResult(JSON.stringify(r.data, null, 2), r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── tickera_get_event ─────────────────────────────────────────────
  server.registerTool(
    "tickera_get_event",
    {
      title: "Get Tickera Event",
      description: `Get one Tickera event by ID, including its ticket-type products.`,
      inputSchema: {
        event_id: z.number().int().describe("The tc_events post ID."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: true },
    },
    async (params: { event_id: number; response_format?: ResponseFormat }) => {
      try {
        const r = await makeApiRequest<Record<string, unknown>>(tb(`tickera/event/${params.event_id}`));
        return toolResult(JSON.stringify(r.data, null, 2), r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── tickera_create_event ──────────────────────────────────────────
  server.registerTool(
    "tickera_create_event",
    {
      title: "Create Tickera Event",
      description: `Create a Tickera event (tc_events). Use for one performance/show date. Defaults
to status='draft' so nothing goes public until you're ready. Date accepts any
parseable value (e.g. '2026-09-19 19:30'); stored as Tickera's 'Y-m-d H:i'.
After creating the event, add ticket tiers with tickera_create_ticket_type.`,
      inputSchema: {
        title: z.string().describe("Event title, e.g. 'Season Opener — Sep 19, Boulder'."),
        date: z.string().optional().describe("Start date/time, e.g. '2026-09-19 19:30'."),
        end_date: z.string().optional().describe("Optional end date/time."),
        location: z.string().optional().describe("Venue / location text."),
        description: z.string().optional().describe("Event description (HTML allowed)."),
        status: z.enum(["draft", "publish"]).default("draft").describe("Post status. Default draft."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (params: Record<string, unknown>) => {
      try {
        const body: Record<string, unknown> = {};
        for (const f of ["title", "date", "end_date", "location", "description", "status"]) {
          if (params[f] !== undefined) body[f] = params[f];
        }
        const r = await makeApiRequest<Record<string, unknown>>(tb("tickera/event"), "POST", undefined, body);
        return toolResult(`# Event created\n\n${JSON.stringify(r.data, null, 2)}`, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── tickera_list_templates ────────────────────────────────────────
  server.registerTool(
    "tickera_list_templates",
    {
      title: "List Tickera Ticket Templates",
      description: `List Tickera ticket templates (used on PDF/printed tickets). Use to pick a
ticket_template ID for tickera_create_ticket_type; if omitted there, the
plugin uses the default template.`,
      inputSchema: { response_format: ResponseFormatField },
      annotations: { readOnlyHint: true },
    },
    async (params: { response_format?: ResponseFormat }) => {
      try {
        const r = await makeApiRequest<Record<string, unknown>>(tb("tickera/templates"));
        return toolResult(JSON.stringify(r.data, null, 2), r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── tickera_create_ticket_type ────────────────────────────────────
  server.registerTool(
    "tickera_create_ticket_type",
    {
      title: "Create Tickera Ticket Type",
      description: `Create a ticket tier for an event (e.g. Orchestra / Balcony / GA / Student).
Creates a WooCommerce product and wires it to the event via the Bridge meta, so
it sells through the normal Woo cart/Stripe checkout. Requires an existing
event_id (from tickera_create_event or tickera_list_events).`,
      inputSchema: {
        event_id: z.number().int().describe("The tc_events event ID this tier belongs to."),
        name: z.string().describe("Tier name, e.g. 'Season Opener — Orchestra'."),
        price: z.string().optional().describe("Price as string, e.g. '35.00'. Omit for TBD placeholder."),
        stock: z.number().int().optional().describe("Quantity available (enables stock management). Omit for unlimited."),
        description: z.string().optional().describe("Product description (HTML allowed)."),
        short_description: z.string().optional().describe("Short description (HTML allowed)."),
        sku: z.string().optional().describe("Optional unique SKU, e.g. 'ANS-SEP26-ORCH'."),
        ticket_template: z.number().int().optional().describe("Ticket template ID. Omit to use the default."),
        status: z.enum(["draft", "publish"]).default("publish").describe("Product status. Default publish."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (params: Record<string, unknown>) => {
      try {
        const body: Record<string, unknown> = {};
        for (const f of [
          "event_id", "name", "price", "stock", "description",
          "short_description", "sku", "ticket_template", "status",
        ]) {
          if (params[f] !== undefined) body[f] = params[f];
        }
        const r = await makeApiRequest<Record<string, unknown>>(tb("tickera/ticket-type"), "POST", undefined, body);
        return toolResult(`# Ticket type created\n\n${JSON.stringify(r.data, null, 2)}`, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── tickera_list_ticket_types ─────────────────────────────────────
  server.registerTool(
    "tickera_list_ticket_types",
    {
      title: "List Tickera Ticket Types",
      description: `List ticket-type products, optionally filtered to one event_id.`,
      inputSchema: {
        event_id: z.number().int().optional().describe("Filter to one event's tiers. Omit for all."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: true },
    },
    async (params: { event_id?: number; response_format?: ResponseFormat }) => {
      try {
        const query: Record<string, unknown> = {};
        if (params.event_id !== undefined) query.event_id = params.event_id;
        const r = await makeApiRequest<Record<string, unknown>>(tb("tickera/ticket-types"), "GET", query);
        return toolResult(JSON.stringify(r.data, null, 2), r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

} // end registerTickeraTools
