/**
 * OAuth 2.1 for the remote connector: each person signs in with their own Google account.
 *
 * Ported from local-pm-Ars mcp-server/src/oauth.ts (same flow, same stateless design) so
 * this connector can be added at the Claude ORGANISATION level, where a static token in the
 * URL is not an option (INFRA-15).
 *
 *   Claude ──/register (DCR)──▶ here            client_id = sealed blob, nothing stored
 *   Claude ──/authorize──────▶ here ──302──▶ Google sign-in (hd = our Workspace domain)
 *   Google ──/oauth/google/callback──▶ here     verify ID token, email → WordPress identity
 *          ──302──▶ Claude redirect_uri?code=…  code = sealed blob (PKCE challenge inside)
 *   Claude ──/token──────────▶ here             access token (1h) + refresh token (30d)
 *   Claude ──/mcp  Bearer …──▶ here             token → email → that person's WP app password
 *
 * WHO MAY SIGN IN. A verified Google account in OAUTH_ALLOWED_DOMAIN, AND an email that
 * auth.ts maps to a WordPress identity (MCP_AUTH_IDENTITIES[].email). An unmapped email is
 * refused unless OAUTH_UNMAPPED=shared. Being in the Workspace is not, on its own, enough to
 * write to the live website.
 *
 * STATELESS ON PURPOSE. Cloud Run scales to N instances and to zero. Every artefact (client
 * registration, pending authorization, auth code, refresh token) is an A256GCM JWE under
 * OAUTH_SECRET; access tokens are HS256 JWTs under a key derived from the same secret.
 *
 * Revocation: remove the email from MCP_AUTH_IDENTITIES (takes effect on the next request,
 * because every token check re-resolves the email), revoke the person's WordPress
 * Application Password, or rotate OAUTH_SECRET to log everybody out.
 *
 * Known limit: an auth code is replayable until it expires (5 minutes). PKCE makes a stolen
 * code useless without the verifier.
 */
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { EncryptJWT, jwtDecrypt, SignJWT, jwtVerify } from "jose";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { authenticateEmail } from "./auth.js";

export interface OAuthConfig {
  /** Public base URL of this service (no trailing slash). */
  publicUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  /** Workspace domain people must sign in with, e.g. arsnovasingers.org. */
  allowedDomain: string;
  /** ≥32 random bytes, base64. Encrypts and signs everything this module issues. */
  secret: string;
}

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 5 * 60;
const PENDING_TTL_S = 10 * 60;
export const OAUTH_SCOPE = "wordpress";

export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";

type Sealed = Record<string, unknown>;

/** undefined = OAuth not configured (token-only mode). Partial config is a boot error. */
export function loadOAuthConfig(): OAuthConfig | undefined {
  // Trimmed: values mounted from Secret Manager often carry a trailing newline.
  const env = (k: string) => process.env[k]?.trim() || undefined;
  const vals = {
    PUBLIC_URL: env("PUBLIC_URL"),
    GOOGLE_OAUTH_CLIENT_ID: env("GOOGLE_OAUTH_CLIENT_ID"),
    GOOGLE_OAUTH_CLIENT_SECRET: env("GOOGLE_OAUTH_CLIENT_SECRET"),
    OAUTH_SECRET: env("OAUTH_SECRET"),
    OAUTH_ALLOWED_DOMAIN: env("OAUTH_ALLOWED_DOMAIN"),
  };
  const missing = Object.entries(vals).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length === Object.keys(vals).length) return undefined;
  if (missing.length) {
    // Half-configured OAuth would boot and silently fall back to token-only. Refuse instead.
    throw new Error(`OAuth is partly configured; missing: ${missing.join(", ")}`);
  }
  return {
    publicUrl: vals.PUBLIC_URL!.replace(/\/+$/, ""),
    googleClientId: vals.GOOGLE_OAUTH_CLIENT_ID!,
    googleClientSecret: vals.GOOGLE_OAUTH_CLIENT_SECRET!,
    allowedDomain: vals.OAUTH_ALLOWED_DOMAIN!.toLowerCase(),
    secret: vals.OAUTH_SECRET!,
  };
}

export class GoogleOAuthProvider implements OAuthServerProvider {
  private readonly encKey: Uint8Array;
  private readonly sigKey: Uint8Array;
  private readonly google: OAuth2Client;

  constructor(private readonly cfg: OAuthConfig) {
    const root = Buffer.from(cfg.secret, "base64");
    if (root.length < 32) throw new Error("OAUTH_SECRET must be at least 32 bytes, base64-encoded");
    this.encKey = new Uint8Array(
      crypto.hkdfSync("sha256", root, Buffer.alloc(0), "ans-wordpress-mcp/enc", 32)
    );
    this.sigKey = new Uint8Array(
      crypto.hkdfSync("sha256", root, Buffer.alloc(0), "ans-wordpress-mcp/sig", 32)
    );
    this.google = new OAuth2Client(cfg.googleClientId, cfg.googleClientSecret, this.callbackUrl);
  }

  get callbackUrl(): string {
    return `${this.cfg.publicUrl}${GOOGLE_CALLBACK_PATH}`;
  }

  get resourceUrl(): string {
    return `${this.cfg.publicUrl}/mcp`;
  }

  private async seal(typ: string, payload: Sealed, ttlS: number): Promise<string> {
    return new EncryptJWT({ ...payload, typ })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt()
      .setExpirationTime(`${ttlS}s`)
      .encrypt(this.encKey);
  }

  private async unseal(typ: string, token: string): Promise<Sealed> {
    try {
      const { payload } = await jwtDecrypt(token, this.encKey);
      if (payload.typ !== typ) throw new Error("wrong type");
      return payload as Sealed;
    } catch {
      throw new InvalidGrantError(`invalid or expired ${typ}`);
    }
  }

  private fingerprint(clientId: string): string {
    return crypto.createHash("sha256").update(clientId).digest("base64url").slice(0, 22);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      registerClient: async (client) => {
        const body = { ...client, client_id_issued_at: Math.floor(Date.now() / 1000) };
        const client_id = await new EncryptJWT({ typ: "client", c: body })
          .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
          .encrypt(this.encKey);
        return { ...body, client_id } as OAuthClientInformationFull;
      },
      getClient: async (clientId) => {
        try {
          const { payload } = await jwtDecrypt(clientId, this.encKey);
          if (payload.typ !== "client") return undefined;
          return { ...(payload.c as object), client_id: clientId } as OAuthClientInformationFull;
        } catch {
          return undefined;
        }
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const pending = await this.seal(
      "pending",
      {
        cid: client.client_id,
        redirectUri: params.redirectUri,
        state: params.state,
        codeChallenge: params.codeChallenge,
        scopes: params.scopes ?? [OAUTH_SCOPE],
        resource: params.resource?.href,
      },
      PENDING_TTL_S
    );

    const url = this.google.generateAuthUrl({
      access_type: "online",
      scope: ["openid", "email", "profile"],
      state: pending,
      hd: this.cfg.allowedDomain, // a hint only; enforced again in the callback
      prompt: "select_account",
    });
    res.redirect(302, url);
  }

  googleCallback = async (req: Request, res: Response): Promise<void> => {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    if (!state) {
      res.status(400).send("Missing state.");
      return;
    }

    let pending: Sealed;
    try {
      pending = await this.unseal("pending", state);
    } catch {
      res.status(400).send("This sign-in link has expired. Go back to Claude and click Connect again.");
      return;
    }

    const back = (params: Record<string, string>) => {
      const u = new URL(String(pending.redirectUri));
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (pending.state) u.searchParams.set("state", String(pending.state));
      res.redirect(302, u.href);
    };

    if (!code) {
      back({
        error: "access_denied",
        error_description: String(req.query.error ?? "Google sign-in was cancelled"),
      });
      return;
    }

    let email: string;
    try {
      const { tokens } = await this.google.getToken(code);
      const ticket = await this.google.verifyIdToken({
        idToken: tokens.id_token!,
        audience: this.cfg.googleClientId,
      });
      const p = ticket.getPayload();
      if (!p?.email || !p.email_verified) throw new Error("Google did not return a verified email");
      if ((p.hd ?? "").toLowerCase() !== this.cfg.allowedDomain) {
        throw new Error(`Sign in with your @${this.cfg.allowedDomain} account`);
      }
      email = p.email.toLowerCase();
    } catch (err) {
      back({
        error: "access_denied",
        error_description: err instanceof Error ? err.message : "Google sign-in failed",
      });
      return;
    }

    if (!authenticateEmail(email).ok) {
      console.error(`oauth: refused ${email} (no WordPress identity mapped)`);
      back({
        error: "access_denied",
        error_description: `${email} is not set up for this WordPress connector. Ask Jonathan.`,
      });
      return;
    }

    console.error(`oauth: ${email} signed in`);
    const authCode = await this.seal(
      "code",
      {
        cid: this.fingerprint(String(pending.cid)),
        email,
        codeChallenge: pending.codeChallenge,
        redirectUri: pending.redirectUri,
        scopes: pending.scopes,
        resource: pending.resource,
      },
      CODE_TTL_S
    );
    back({ code: authCode });
  };

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const c = await this.unseal("code", authorizationCode);
    if (c.cid !== this.fingerprint(client.client_id)) {
      throw new InvalidGrantError("code was issued to another client");
    }
    return String(c.codeChallenge);
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // PKCE is checked by the SDK's token handler before this runs
    redirectUri?: string
  ): Promise<OAuthTokens> {
    const c = await this.unseal("code", authorizationCode);
    if (c.cid !== this.fingerprint(client.client_id)) {
      throw new InvalidGrantError("code was issued to another client");
    }
    if (redirectUri && redirectUri !== c.redirectUri) {
      throw new InvalidGrantError("redirect_uri mismatch");
    }
    return this.issueTokens(String(c.cid), String(c.email), (c.scopes as string[]) ?? [OAUTH_SCOPE]);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string
  ): Promise<OAuthTokens> {
    const r = await this.unseal("refresh", refreshToken);
    if (r.cid !== this.fingerprint(client.client_id)) {
      throw new InvalidGrantError("refresh token was issued to another client");
    }
    if (!authenticateEmail(String(r.email)).ok) {
      throw new InvalidGrantError("no longer allowed to use this connector");
    }
    return this.issueTokens(String(r.cid), String(r.email), (r.scopes as string[]) ?? [OAUTH_SCOPE]);
  }

  private async issueTokens(cid: string, email: string, scopes: string[]): Promise<OAuthTokens> {
    const access_token = await new SignJWT({ typ: "access", cid, scope: scopes.join(" ") })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(email)
      .setAudience(this.resourceUrl)
      .setIssuer(this.cfg.publicUrl)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_S}s`)
      .sign(this.sigKey);
    const refresh_token = await this.seal("refresh", { cid, email, scopes }, REFRESH_TTL_S);
    return {
      access_token,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token,
      scope: scopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.sigKey, {
        audience: this.resourceUrl,
        issuer: this.cfg.publicUrl,
      }));
    } catch {
      throw new InvalidTokenError("invalid or expired access token");
    }
    if (payload.typ !== "access" || !payload.sub) throw new InvalidTokenError("not an access token");
    if (!authenticateEmail(payload.sub).ok) {
      throw new InvalidTokenError("no longer allowed to use this connector");
    }
    return {
      token,
      clientId: String(payload.cid),
      scopes: String(payload.scope ?? OAUTH_SCOPE).split(" "),
      expiresAt: payload.exp,
      resource: new URL(this.resourceUrl),
      extra: { email: payload.sub },
    };
  }
}

export function googleCallbackRouter(provider: GoogleOAuthProvider): express.Router {
  const r = express.Router();
  r.get(GOOGLE_CALLBACK_PATH, provider.googleCallback);
  return r;
}
