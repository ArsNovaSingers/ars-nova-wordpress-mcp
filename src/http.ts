/**
 * ars-nova-wordpress-mcp — Streamable HTTP entry point (Cloud Run).
 *
 * Same tools as stdio; different transport. Gated by a token supplied either as an
 * `Authorization: Bearer` header (PREFERRED) or `?key=` on the URL.
 *
 * ⚠️ Corrected 2026-09-01: this comment previously said the query-param form existed
 * because Claude's custom-connector UI has no static header field
 * (anthropics/claude-ai-mcp#112, closed "not planned"). That is FALSE - the
 * Add-custom-connector dialog has a "Request headers" section taking up to four
 * headers. Prefer the header: a token in `?key=` is written to the Cloud Run request
 * log in plaintext, and a header is not. `?key=` is kept only for existing configs.
 *
 * Callers may present either the shared MCP_AUTH_TOKEN (which acts as the env-var
 * WordPress account, unchanged) or their own token from MCP_AUTH_IDENTITIES, which
 * acts as their own WordPress user. See auth.ts.
 *
 * 2026-11-09 (INFRA-15): optional Google sign-in (oauth.ts), so the connector can be added
 * at the Claude ORG level and used from any surface. Tokens above keep working alongside it.
 * An OAuth user acts as the MCP_AUTH_IDENTITIES entry whose "email" matches; unmapped
 * emails are refused unless OAUTH_UNMAPPED=shared.
 *
 * Env: WP_SITE_URL, WP_USERNAME, WP_APP_PASSWORD, WP_ENV_LABEL, PORT,
 *      at least one of MCP_AUTH_TOKEN / MCP_AUTH_IDENTITIES / OAuth, where OAuth is all of
 *      PUBLIC_URL, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, OAUTH_SECRET,
 *      OAUTH_ALLOWED_DOMAIN (all or none), plus optional OAUTH_UNMAPPED=deny|shared and OAUTH_SHARED_EMAILS
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { createServer, validateEnvOrExit } from "./server.js";
import {
  authenticate,
  authenticateEmail,
  hasAnyCredential,
  identityLabels,
  identityStore,
  loadAuthConfig,
  oauthEmails,
  oauthUnmappedPolicy,
  type AuthResult,
  type WpIdentity,
} from "./auth.js";
import {
  GoogleOAuthProvider,
  OAUTH_SCOPE,
  googleCallbackRouter,
  loadOAuthConfig,
  type OAuthConfig,
} from "./oauth.js";

const PORT = Number(process.env.PORT || 8080);
const ENV_LABEL = process.env.WP_ENV_LABEL || "unlabelled";

validateEnvOrExit();

// Throws (and so refuses to boot) on malformed MCP_AUTH_IDENTITIES, rather than
// starting up and rejecting every request for a reason nobody can see.
let oauthConfig: OAuthConfig | undefined;
let oauthProvider: GoogleOAuthProvider | undefined;
try {
  loadAuthConfig();
  oauthConfig = loadOAuthConfig();
  oauthProvider = oauthConfig ? new GoogleOAuthProvider(oauthConfig) : undefined;
} catch (err) {
  console.error(`[${SERVER_NAME}] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (!hasAnyCredential() && !oauthProvider) {
  console.error(
    `[${SERVER_NAME}] FATAL: no MCP_AUTH_TOKEN, no token in MCP_AUTH_IDENTITIES, and OAuth is not ` +
    `configured. Refusing to expose WordPress write access on an unauthenticated endpoint.`
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

if (oauthProvider && oauthConfig) {
  // OAuth mode (INFRA-15): serves /.well-known/*, /register, /authorize, /token.
  app.set("trust proxy", 1); // Cloud Run fronts us; the SDK's rate limiter keys on client IP
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(oauthConfig.publicUrl),
      resourceServerUrl: new URL(oauthProvider.resourceUrl),
      resourceName: `Ars Nova WordPress (${ENV_LABEL})`,
      scopesSupported: [OAUTH_SCOPE],
      clientRegistrationOptions: { clientIdGeneration: false }, // oauth.ts seals the registration into the id
    })
  );
  app.use(googleCallbackRouter(oauthProvider));
} else {
  // Token-only mode: Claude probes these when adding a connector. 401 pushes it off
  // the OAuth path and onto the token path.
  app.all(/^\/\.well-known\/.*/, (_req: Request, res: Response) => {
    res.status(401).end();
  });
}

const bearer = oauthProvider
  ? requireBearerAuth({
      verifier: oauthProvider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(oauthProvider.resourceUrl)),
    })
  : undefined;

function unauthorized(req: Request, res: Response): void {
  console.error(`[${SERVER_NAME}] unauthorized /mcp attempt from ${req.ip}`);
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
    id: null,
  });
}

/**
 * Resolves WHO is calling into res.locals.auth. A static token (shared or per-person)
 * is tried first, so existing connector configs keep working unchanged; anything else
 * goes to the OAuth bearer check, whose 401 carries the WWW-Authenticate header Claude
 * needs to start sign-in.
 */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const byToken = authenticate(presentedToken(req));
  if (byToken.ok) {
    res.locals.auth = byToken;
    next();
    return;
  }
  if (!bearer) {
    unauthorized(req, res);
    return;
  }
  bearer(req, res, (err?: unknown) => {
    if (err) return next(err);
    const email = req.auth?.extra?.email;
    if (typeof email !== "string") return unauthorized(req, res);
    const byEmail = authenticateEmail(email);
    if (!byEmail.ok) return unauthorized(req, res);
    res.locals.auth = byEmail;
    next();
  });
}

app.post("/mcp", requireAuth, async (req: Request, res: Response) => {
  const auth = res.locals.auth as Extract<AuthResult, { ok: true }>;

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
  console.error(
    `[${SERVER_NAME}] OAuth ${oauthProvider ? "ON" : "off"}` +
    (oauthProvider
      ? ` (domain ${oauthConfig!.allowedDomain}; mapped: ${oauthEmails().join(", ") || "none"}; ` +
        `unmapped: ${oauthUnmappedPolicy()})`
      : "")
  );
});
