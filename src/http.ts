/**
 * ars-nova-wordpress-mcp — Streamable HTTP entry point (Cloud Run).
 *
 * Same tools as stdio; different transport. Gated by MCP_AUTH_TOKEN, supplied
 * either as `?key=` on the URL or an `Authorization: Bearer` header. The
 * query-param form is not a shortcut - Claude's custom-connector UI has no
 * static header field (anthropics/claude-ai-mcp#112, closed "not planned").
 *
 * Callers may present either the shared MCP_AUTH_TOKEN (which acts as the env-var
 * WordPress account, unchanged) or their own token from MCP_AUTH_IDENTITIES, which
 * acts as their own WordPress user. See auth.ts.
 *
 * Env: WP_SITE_URL, WP_USERNAME, WP_APP_PASSWORD, WP_ENV_LABEL, PORT,
 *      and at least one of MCP_AUTH_TOKEN / MCP_AUTH_IDENTITIES
 */
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { createServer, validateEnvOrExit } from "./server.js";
import {
  authenticate,
  hasAnyCredential,
  identityLabels,
  identityStore,
  loadAuthConfig,
  type WpIdentity,
} from "./auth.js";

const PORT = Number(process.env.PORT || 8080);
const ENV_LABEL = process.env.WP_ENV_LABEL || "unlabelled";

validateEnvOrExit();

// Throws (and so refuses to boot) on malformed MCP_AUTH_IDENTITIES, rather than
// starting up and rejecting every request for a reason nobody can see.
try {
  loadAuthConfig();
} catch (err) {
  console.error(`[${SERVER_NAME}] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (!hasAnyCredential()) {
  console.error(
    `[${SERVER_NAME}] FATAL: neither MCP_AUTH_TOKEN nor MCP_AUTH_IDENTITIES is set. ` +
    `Refusing to expose WordPress write access on an unauthenticated endpoint.`
  );
  process.exit(1);
}

/** Extract the presented token: Bearer header first, then ?key= on the URL. */
function presentedToken(req: Request): string | null {
  const h = req.get("authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  const q = req.query.key;
  return typeof q === "string" ? q : null;
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
  const auth = authenticate(presentedToken(req));
  if (!auth.ok) {
    console.error(`[${SERVER_NAME}] unauthorized /mcp attempt from ${req.ip}`);
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
    return;
  }

  // Log WHO, never the token. Before this existed, every action on the site was
  // attributable only to one shared WordPress account.
  console.error(`[${SERVER_NAME}] /mcp as "${auth.label}" [${ENV_LABEL}]`);

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

  // Everything the tools do runs inside this context, so getWpClient() can pick up
  // the caller's own WordPress credentials without any tool module knowing about it.
  const run = async (): Promise<void> => {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  try {
    if (auth.identity) {
      await identityStore.run(auth.identity as WpIdentity, run);
    } else {
      await run();
    }
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
    `-> ${process.env.WP_SITE_URL} ` +
    `(identities: ${identityLabels().join(", ") || "none"})`
  );
});
