/**
 * ars-nova-wordpress-mcp — Streamable HTTP entry point (Cloud Run).
 *
 * Same tools as stdio; different transport. Gated by MCP_AUTH_TOKEN, supplied
 * either as `?key=` on the URL or an `Authorization: Bearer` header. The
 * query-param form is not a shortcut - Claude's custom-connector UI has no
 * static header field (anthropics/claude-ai-mcp#112, closed "not planned").
 *
 * Env: WP_SITE_URL, WP_USERNAME, WP_APP_PASSWORD, WP_ENV_LABEL, MCP_AUTH_TOKEN, PORT
 */
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { createServer, validateEnvOrExit } from "./server.js";

const PORT = Number(process.env.PORT || 8080);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const ENV_LABEL = process.env.WP_ENV_LABEL || "unlabelled";

validateEnvOrExit();

if (!AUTH_TOKEN) {
  console.error(
    `[${SERVER_NAME}] FATAL: MCP_AUTH_TOKEN is not set. Refusing to expose ` +
    `WordPress write access on an unauthenticated endpoint.`
  );
  process.exit(1);
}

function authorized(req: Request): boolean {
  const q = req.query.key;
  if (typeof q === "string" && q === AUTH_TOKEN) return true;
  const h = req.get("authorization") || "";
  if (h.startsWith("Bearer ") && h.slice(7) === AUTH_TOKEN) return true;
  return false;
}

const app = express();
app.use(express.json({ limit: "25mb" }));

app.get("/", (_req: Request, res: Response) => {
  res
    .status(200)
    .send(`${SERVER_NAME} v${SERVER_VERSION} [${ENV_LABEL}] — MCP endpoint: POST /mcp`);
});

// Claude probes these when adding a connector. 401 pushes it off the OAuth
// path and onto the token-in-URL path.
app.all(/^\/\.well-known\/.*/, (_req: Request, res: Response) => {
  res.status(401).end();
});

app.post("/mcp", async (req: Request, res: Response) => {
  if (!authorized(req)) {
    console.error(`[${SERVER_NAME}] unauthorized /mcp attempt from ${req.ip}`);
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }

  // Stateless: a fresh server + transport per request, so concurrent callers
  // cannot share session state.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error: unknown) {
    console.error(`[${SERVER_NAME}] transport error:`, error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode does not support server-initiated streams or session deletes.
app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)" },
    id: null,
  });
});

app.listen(PORT, () => {
  console.error(
    `[${SERVER_NAME}] v${SERVER_VERSION} [${ENV_LABEL}] listening on :${PORT} ` +
    `-> ${process.env.WP_SITE_URL}`
  );
});
