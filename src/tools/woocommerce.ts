/**
 * WooCommerce REST API v3 tools.
 *
 * Provides tools for managing WooCommerce settings, products, payment gateways,
 * orders, and system status via /wp-json/wc/v3/*.
 *
 * Uses the same Basic Auth (Application Passwords) as the core WP tools —
 * no additional credentials needed.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { makeApiRequest } from "../services/wp-client.js";
import { toolError, toolResult } from "../services/formatters.js";
import { ResponseFormatField } from "../schemas/common.js";
import { ResponseFormat } from "../types.js";

const WC_NS = "wc/v3";

/** Helper: build a WC v3 endpoint path. */
function wc(path: string): string {
  return `${WC_NS}/${path.replace(/^\/+/, "")}`;
}

export function registerWooCommerceTools(server: McpServer): void {

  // ─── wc_get_settings ───────────────────────────────────────────────
  server.registerTool(
    "wc_get_settings",
    {
      title: "Get WooCommerce Settings",
      description: `Read a WooCommerce settings group. Groups include: general, products, tax,
shipping, checkout (= payments), advanced, email.
Returns all setting IDs and their current values for the group.`,
      inputSchema: {
        group: z.string().describe("Settings group ID, e.g. 'general', 'tax', 'advanced', 'products'."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: true },
    },
    async (params: { group: string; response_format?: ResponseFormat }) => {
      try {
        const r = await makeApiRequest<unknown[]>(wc(`settings/${params.group}`));
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : formatSettings(r.data as SettingItem[]);
        return toolResult(text, { group: params.group, settings: r.data });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wc_update_setting ─────────────────────────────────────────────
  server.registerTool(
    "wc_update_setting",
    {
      title: "Update WooCommerce Setting",
      description: `Update a single WooCommerce setting by group and setting ID.
Example: group='general', setting_id='woocommerce_currency', value='USD'.
Common settings:
  general: woocommerce_currency, woocommerce_store_address, woocommerce_store_city,
           woocommerce_default_country, woocommerce_store_postcode,
           woocommerce_calc_taxes (yes/no)
  tax: woocommerce_prices_include_tax, woocommerce_tax_based_on,
       woocommerce_tax_display_shop, woocommerce_tax_display_cart
  advanced: woocommerce_cart_page_id, woocommerce_checkout_page_id,
            woocommerce_myaccount_page_id, woocommerce_terms_page_id`,
      inputSchema: {
        group: z.string().describe("Settings group ID, e.g. 'general', 'tax', 'advanced'."),
        setting_id: z.string().describe("Setting ID, e.g. 'woocommerce_currency'."),
        value: z.string().describe("New value for the setting."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (params: { group: string; setting_id: string; value: string; response_format?: ResponseFormat }) => {
      try {
        const r = await makeApiRequest<Record<string, unknown>>(
          wc(`settings/${params.group}/${params.setting_id}`),
          "PUT",
          undefined,
          { value: params.value }
        );
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : `Setting **${params.setting_id}** updated to: \`${params.value}\``;
        return toolResult(text, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wc_list_products ──────────────────────────────────────────────
  server.registerTool(
    "wc_list_products",
    {
      title: "List WooCommerce Products",
      description: `List WooCommerce products with optional filters.
Returns product ID, name, type, status, price, SKU, and stock info.`,
      inputSchema: {
        status: z.enum(["any", "draft", "pending", "private", "publish"]).default("any")
          .describe("Filter by product status."),
        type: z.enum(["simple", "grouped", "external", "variable"]).optional()
          .describe("Filter by product type."),
        search: z.string().optional().describe("Search by product name."),
        per_page: z.number().int().min(1).max(100).default(20)
          .describe("Results per page (max 100)."),
        page: z.number().int().min(1).default(1).describe("Page number."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: true },
    },
    async (params: {
      status?: string; type?: string; search?: string;
      per_page?: number; page?: number; response_format?: ResponseFormat;
    }) => {
      try {
        const queryParams: Record<string, unknown> = {
          status: params.status ?? "any",
          per_page: params.per_page ?? 20,
          page: params.page ?? 1,
        };
        if (params.type) queryParams.type = params.type;
        if (params.search) queryParams.search = params.search;

        const r = await makeApiRequest<WcProduct[]>(wc("products"), "GET", queryParams);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify({ total: r.total, products: r.data }, null, 2)
          : formatProducts(r.data, r.total);
        return toolResult(text, { total: r.total, products: r.data });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wc_create_product ─────────────────────────────────────────────
  server.registerTool(
    "wc_create_product",
    {
      title: "Create WooCommerce Product",
      description: `Create a new WooCommerce product. For Tickera ticket products, set
type='simple' and the product will be available for Tickera bridge mapping.
Supports simple products with price, description, categories, and images.`,
      inputSchema: {
        name: z.string().describe("Product name."),
        type: z.enum(["simple", "grouped", "external", "variable"]).default("simple")
          .describe("Product type."),
        status: z.enum(["draft", "pending", "private", "publish"]).default("publish")
          .describe("Product status."),
        regular_price: z.string().optional().describe("Regular price as string, e.g. '25.00'."),
        description: z.string().optional().describe("Full product description (HTML)."),
        short_description: z.string().optional().describe("Short description (HTML)."),
        sku: z.string().optional().describe("Unique SKU."),
        virtual: z.boolean().default(true).describe("Virtual product (no shipping). Default true for tickets."),
        downloadable: z.boolean().default(false).describe("Downloadable product."),
        catalog_visibility: z.enum(["visible", "catalog", "search", "hidden"]).default("visible")
          .describe("Catalog visibility."),
        categories: z.array(z.object({ id: z.number() })).optional()
          .describe("Array of category objects with id, e.g. [{id: 15}]."),
        manage_stock: z.boolean().optional().describe("Enable stock management."),
        stock_quantity: z.number().int().optional().describe("Stock quantity if manage_stock is true."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (params: Record<string, unknown>) => {
      try {
        const body: Record<string, unknown> = {};
        const fields = [
          "name", "type", "status", "regular_price", "description",
          "short_description", "sku", "virtual", "downloadable",
          "catalog_visibility", "categories", "manage_stock", "stock_quantity",
        ];
        for (const f of fields) {
          if (params[f] !== undefined) body[f] = params[f];
        }

        const r = await makeApiRequest<WcProduct>(wc("products"), "POST", undefined, body);
        const p = r.data;
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(p, null, 2)
          : `# Product Created\n\n- **ID**: ${p.id}\n- **Name**: ${p.name}\n- **Type**: ${p.type}\n- **Status**: ${p.status}\n- **Price**: ${p.regular_price || "(none)"}\n- **SKU**: ${p.sku || "(none)"}\n- **Virtual**: ${p.virtual}\n- **Permalink**: ${p.permalink}`;
        return toolResult(text, p);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wc_update_product ─────────────────────────────────────────────
  server.registerTool(
    "wc_update_product",
    {
      title: "Update WooCommerce Product",
      description: `Update an existing WooCommerce product by ID. Only the fields you pass are changed.`,
      inputSchema: {
        product_id: z.number().int().describe("Product ID to update."),
        name: z.string().optional().describe("Product name."),
        status: z.enum(["draft", "pending", "private", "publish"]).optional(),
        regular_price: z.string().optional().describe("Regular price as string."),
        description: z.string().optional(),
        short_description: z.string().optional(),
        sku: z.string().optional(),
        virtual: z.boolean().optional(),
        manage_stock: z.boolean().optional(),
        stock_quantity: z.number().int().optional(),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (params: Record<string, unknown>) => {
      try {
        const productId = params.product_id as number;
        const body: Record<string, unknown> = {};
        const fields = [
          "name", "status", "regular_price", "description",
          "short_description", "sku", "virtual", "manage_stock", "stock_quantity",
        ];
        for (const f of fields) {
          if (params[f] !== undefined) body[f] = params[f];
        }
        if (Object.keys(body).length === 0) {
          return toolError("No fields provided to update.");
        }

        const r = await makeApiRequest<WcProduct>(wc(`products/${productId}`), "PUT", undefined, body);
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : `Product **${r.data.id}** (${r.data.name}) updated. Changed: ${Object.keys(body).join(", ")}`;
        return toolResult(text, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wc_list_payment_gateways ──────────────────────────────────────
  server.registerTool(
    "wc_list_payment_gateways",
    {
      title: "List WooCommerce Payment Gateways",
      description: `List all registered payment gateways and their enabled/disabled status.
Shows gateway ID, title, description, enabled state, and method title.
Use this to check if Stripe is enabled and in test mode.`,
      inputSchema: {
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: true },
    },
    async (params: { response_format?: ResponseFormat }) => {
      try {
        const r = await makeApiRequest<WcGateway[]>(wc("payment_gateways"));
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : formatGateways(r.data);
        return toolResult(text, { gateways: r.data });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wc_update_payment_gateway ─────────────────────────────────────
  server.registerTool(
    "wc_update_payment_gateway",
    {
      title: "Update WooCommerce Payment Gateway",
      description: `Update a payment gateway's settings. Use to enable/disable a gateway or
change its title/description. For Stripe test mode keys, Jon handles those
directly in WP Admin — this tool can enable/disable the gateway only.`,
      inputSchema: {
        gateway_id: z.string().describe("Gateway ID, e.g. 'stripe', 'cod', 'bacs', 'cheque'."),
        enabled: z.boolean().optional().describe("Enable or disable the gateway."),
        title: z.string().optional().describe("Gateway title shown at checkout."),
        description: z.string().optional().describe("Gateway description shown at checkout."),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (params: { gateway_id: string; enabled?: boolean; title?: string; description?: string; response_format?: ResponseFormat }) => {
      try {
        const body: Record<string, unknown> = {};
        if (params.enabled !== undefined) body.enabled = params.enabled;
        if (params.title !== undefined) body.title = params.title;
        if (params.description !== undefined) body.description = params.description;
        if (Object.keys(body).length === 0) {
          return toolError("No fields provided to update.");
        }

        const r = await makeApiRequest<WcGateway>(
          wc(`payment_gateways/${params.gateway_id}`), "PUT", undefined, body
        );
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : `Gateway **${r.data.id}** updated. Enabled: ${r.data.enabled}, Title: "${r.data.title}"`;
        return toolResult(text, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wc_list_orders ────────────────────────────────────────────────
  server.registerTool(
    "wc_list_orders",
    {
      title: "List WooCommerce Orders",
      description: `List WooCommerce orders with optional status filter.
Returns order ID, status, total, customer info, and line items.`,
      inputSchema: {
        status: z.enum(["any", "pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "trash"])
          .default("any").describe("Filter by order status."),
        per_page: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).default(1),
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: true },
    },
    async (params: { status?: string; per_page?: number; page?: number; response_format?: ResponseFormat }) => {
      try {
        const r = await makeApiRequest<WcOrder[]>(wc("orders"), "GET", {
          status: params.status ?? "any",
          per_page: params.per_page ?? 20,
          page: params.page ?? 1,
        });
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify({ total: r.total, orders: r.data }, null, 2)
          : formatOrders(r.data, r.total);
        return toolResult(text, { total: r.total, orders: r.data });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wc_get_system_status ──────────────────────────────────────────
  server.registerTool(
    "wc_get_system_status",
    {
      title: "WooCommerce System Status",
      description: `Get WooCommerce system status including environment info, database,
active plugins, theme, settings, and pages. Use for health checks.`,
      inputSchema: {
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: true },
    },
    async (params: { response_format?: ResponseFormat }) => {
      try {
        const r = await makeApiRequest<Record<string, unknown>>(wc("system_status"));
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : formatSystemStatus(r.data);
        return toolResult(text, r.data);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wc_list_shipping_zones ────────────────────────────────────────
  server.registerTool(
    "wc_list_shipping_zones",
    {
      title: "List WooCommerce Shipping Zones",
      description: `List shipping zones and their methods. Use to verify shipping is disabled
or check what zones exist.`,
      inputSchema: {
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: true },
    },
    async (params: { response_format?: ResponseFormat }) => {
      try {
        const r = await makeApiRequest<WcShippingZone[]>(wc("shipping/zones"));
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : r.data.map((z: WcShippingZone) => `- **${z.name}** (ID: ${z.id})`).join("\n") || "No shipping zones.";
        return toolResult(`# Shipping Zones\n\n${text}`, { zones: r.data });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

  // ─── wc_list_tax_classes ───────────────────────────────────────────
  server.registerTool(
    "wc_list_tax_classes",
    {
      title: "List WooCommerce Tax Classes",
      description: `List available tax classes.`,
      inputSchema: {
        response_format: ResponseFormatField,
      },
      annotations: { readOnlyHint: true },
    },
    async (params: { response_format?: ResponseFormat }) => {
      try {
        const r = await makeApiRequest<WcTaxClass[]>(wc("taxes/classes"));
        const text = params.response_format === ResponseFormat.JSON
          ? JSON.stringify(r.data, null, 2)
          : r.data.map((tc: WcTaxClass) => `- **${tc.name}** (slug: ${tc.slug})`).join("\n") || "No tax classes.";
        return toolResult(`# Tax Classes\n\n${text}`, { tax_classes: r.data });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    }
  );

} // end registerWooCommerceTools


// ─── Types ─────────────────────────────────────────────────────────────

interface SettingItem {
  id: string;
  label: string;
  description: string;
  type: string;
  value: unknown;
  default: unknown;
  options?: Record<string, string>;
}

interface WcProduct {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  type: string;
  status: string;
  sku: string;
  regular_price: string;
  sale_price: string;
  price: string;
  virtual: boolean;
  downloadable: boolean;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status: string;
  categories: Array<{ id: number; name: string }>;
  date_created: string;
}

interface WcGateway {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
  method_title: string;
  method_description: string;
  settings: Record<string, { id: string; label: string; value: string; type: string }>;
}

interface WcOrder {
  id: number;
  status: string;
  total: string;
  currency: string;
  date_created: string;
  billing: { first_name: string; last_name: string; email: string };
  line_items: Array<{ name: string; quantity: number; total: string }>;
  payment_method_title: string;
}

interface WcShippingZone {
  id: number;
  name: string;
  order: number;
}

interface WcTaxClass {
  slug: string;
  name: string;
}


// ─── Formatters ────────────────────────────────────────────────────────

function formatSettings(settings: SettingItem[]): string {
  if (!settings.length) return "No settings found.";
  return settings
    .map((s) => {
      const val = typeof s.value === "object" ? JSON.stringify(s.value) : String(s.value ?? "");
      const desc = s.description ? ` — ${s.description.replace(/<[^>]*>/g, "")}` : "";
      return `- **${s.label || s.id}** (\`${s.id}\`): \`${val}\`${desc}`;
    })
    .join("\n");
}

function formatProducts(products: WcProduct[], total: number): string {
  if (!products.length) return "No products found.";
  const lines = products.map((p) => {
    const cats = p.categories?.map((c) => c.name).join(", ") || "none";
    return [
      `### ${p.name} (ID ${p.id})`,
      `- Status: ${p.status} | Type: ${p.type}`,
      `- SKU: ${p.sku || "—"} | Price: $${p.price || p.regular_price || "—"}`,
      `- Virtual: ${p.virtual} | Stock: ${p.stock_status}`,
      `- Categories: ${cats}`,
      `- URL: ${p.permalink}`,
    ].join("\n");
  });
  return `**${total} product(s) total**\n\n${lines.join("\n\n")}`;
}

function formatGateways(gateways: WcGateway[]): string {
  if (!gateways.length) return "No payment gateways found.";
  return gateways
    .map((g) => {
      const status = g.enabled ? "ENABLED" : "disabled";
      return `- **${g.title}** (\`${g.id}\`) — ${status}\n  ${g.method_description || ""}`;
    })
    .join("\n");
}

function formatOrders(orders: WcOrder[], total: number): string {
  if (!orders.length) return "No orders found.";
  const lines = orders.map((o) => {
    const items = o.line_items?.map((li) => `${li.name} x${li.quantity}`).join(", ") || "—";
    return [
      `### Order #${o.id} — ${o.status}`,
      `- Date: ${o.date_created}`,
      `- Total: ${o.currency} ${o.total}`,
      `- Customer: ${o.billing?.first_name} ${o.billing?.last_name} (${o.billing?.email})`,
      `- Payment: ${o.payment_method_title || "—"}`,
      `- Items: ${items}`,
    ].join("\n");
  });
  return `**${total} order(s) total**\n\n${lines.join("\n\n")}`;
}

function formatSystemStatus(status: Record<string, unknown>): string {
  const env = status.environment as Record<string, unknown> | undefined;
  const theme = status.theme as Record<string, unknown> | undefined;
  const plugins = status.active_plugins as Array<Record<string, unknown>> | undefined;

  const sections: string[] = [];

  if (env) {
    sections.push(
      [
        "## Environment",
        `- WooCommerce: ${env.version}`,
        `- WordPress: ${env.wp_version}`,
        `- PHP: ${env.php_version}`,
        `- Database: ${env.mysql_version}`,
        `- Currency: ${env.currency} (${env.currency_symbol})`,
      ].join("\n")
    );
  }

  if (theme) {
    sections.push(`## Theme\n- ${theme.name} v${theme.version}`);
  }

  if (plugins && plugins.length) {
    const list = plugins.map((p) => `- ${p.name} v${p.version}`).join("\n");
    sections.push(`## Active Plugins\n${list}`);
  }

  return sections.join("\n\n") || JSON.stringify(status, null, 2);
}
