/**
 * Per-caller identity for the HTTP transport.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until 2026-09-01 this server had exactly one `MCP_AUTH_TOKEN` and one
 * `WP_USERNAME` / `WP_APP_PASSWORD` pair. Everyone who held the token shared one
 * WordPress identity, so:
 *   - a teammate could not be cut off without rotating the token for everybody, and
 *   - every edit landed in WordPress revision history as that one account, which made
 *     "who changed this page?" unanswerable.
 *
 * Now each caller may carry their own token, mapped to their own WordPress
 * Application Password. WordPress's own role system then does the limiting, and its
 * revision history records the real person.
 *
 * WHAT THIS DOES **NOT** DO. Giving someone their own identity does not reduce
 * their privileges. The capabilities they get are exactly the capabilities their
 * WordPress user has. Mapping a token to a WordPress administrator yields an
 * administrator. To narrow someone, change their WordPress ROLE - not this file.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual } from "node:crypto";

export interface WpIdentity {
  /** Human-readable, for logs only. Never sent to WordPress. */
  label: string;
  wpUsername: string;
  wpAppPassword: string;
}

/**
 * The identity of the caller whose request is currently being served. Read by
 * getWpClient(). Empty on the stdio transport, and empty for a legacy
 * MCP_AUTH_TOKEN caller - both of which correctly fall back to the env vars.
 */
export const identityStore = new AsyncLocalStorage<WpIdentity>();

/** token -> identity. Built once at startup, like the token it supplements. */
const identities = new Map<string, WpIdentity>();

/**
 * Google-signed-in email -> identity. Filled from the optional `email` field of
 * MCP_AUTH_IDENTITIES entries. An entry may have an email and no token, which makes it
 * reachable ONLY through OAuth.
 */
const emailIdentities = new Map<string, WpIdentity>();

/**
 * What an OAuth user whose email is NOT in MCP_AUTH_IDENTITIES gets.
 *   "deny"   (default) - refused at sign-in. Fail closed: every org member does not
 *                        automatically get the shared account's WordPress role.
 *   "shared" - acts as the env-var WP_USERNAME account, like the legacy token.
 */
let unmappedPolicy: "deny" | "shared" = "deny";

let legacyToken = "";
let loaded = false;

/**
 * Parse MCP_AUTH_IDENTITIES and MCP_AUTH_TOKEN. Throws on malformed identity JSON
 * rather than starting up with a config that silently authenticates nobody - a
 * server that boots and rejects every request is far harder to diagnose than one
 * that refuses to boot and says why.
 */
export function loadAuthConfig(): void {
  if (loaded) return;

  legacyToken = (process.env.MCP_AUTH_TOKEN || "").trim();

  const raw = (process.env.MCP_AUTH_IDENTITIES || "").trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `MCP_AUTH_IDENTITIES is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
          `Expected an array of { token, label, wpUsername, wpAppPassword }.`
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error("MCP_AUTH_IDENTITIES must be a JSON ARRAY of identity objects.");
    }

    parsed.forEach((entry, i) => {
      const e = entry as Record<string, unknown>;
      const token = typeof e?.token === "string" ? e.token.trim() : "";
      const email = typeof e?.email === "string" ? e.email.trim().toLowerCase() : "";
      const wpUsername = typeof e?.wpUsername === "string" ? e.wpUsername.trim() : "";
      const wpAppPassword = typeof e?.wpAppPassword === "string" ? e.wpAppPassword.trim() : "";
      const label =
        typeof e?.label === "string" && e.label.trim() ? e.label.trim() : wpUsername;

      // Name the INDEX, not the value. An error message that echoes a token puts it
      // in the log, which is the exact failure this change is cleaning up after.
      if (!token && !email) {
        throw new Error(`MCP_AUTH_IDENTITIES[${i}] needs a "token", an "email", or both.`);
      }
      if (email) {
        if (!email.includes("@")) {
          throw new Error(`MCP_AUTH_IDENTITIES[${i}] ("${label}") has an invalid "email".`);
        }
        if (emailIdentities.has(email)) {
          throw new Error(`MCP_AUTH_IDENTITIES[${i}] ("${label}") reuses an email already mapped.`);
        }
      }
      if (!token) {
        // OAuth-only identity: reachable by Google sign-in, never by a static token.
        if (!wpUsername) {
          throw new Error(`MCP_AUTH_IDENTITIES[${i}] ("${label}") is missing "wpUsername".`);
        }
        if (!wpAppPassword) {
          throw new Error(`MCP_AUTH_IDENTITIES[${i}] ("${label}") is missing "wpAppPassword".`);
        }
        emailIdentities.set(email, { label, wpUsername, wpAppPassword });
        return;
      }
      if (token.length < 20) {
        throw new Error(
          `MCP_AUTH_IDENTITIES[${i}] ("${label}") has a token shorter than 20 characters.`
        );
      }
      if (!wpUsername) {
        throw new Error(`MCP_AUTH_IDENTITIES[${i}] ("${label}") is missing "wpUsername".`);
      }
      if (!wpAppPassword) {
        throw new Error(`MCP_AUTH_IDENTITIES[${i}] ("${label}") is missing "wpAppPassword".`);
      }
      if (token === legacyToken) {
        throw new Error(
          `MCP_AUTH_IDENTITIES[${i}] ("${label}") reuses the same token as MCP_AUTH_TOKEN. ` +
            `That would make the identity unreachable, because the legacy token matches first.`
        );
      }
      if (identities.has(token)) {
        throw new Error(
          `MCP_AUTH_IDENTITIES[${i}] ("${label}") reuses a token already assigned to another identity.`
        );
      }

      identities.set(token, { label, wpUsername, wpAppPassword });
      if (email) emailIdentities.set(email, { label, wpUsername, wpAppPassword });
    });
  }

  const policy = (process.env.OAUTH_UNMAPPED || "deny").trim().toLowerCase();
  if (policy !== "deny" && policy !== "shared") {
    throw new Error(`OAUTH_UNMAPPED must be "deny" or "shared", got "${policy}".`);
  }
  unmappedPolicy = policy;

  loaded = true;
}

/** True when at least one credential is configured. Used to fail closed at boot. */
export function hasAnyCredential(): boolean {
  return Boolean(legacyToken) || identities.size > 0;
}

/** Labels of configured identities. Safe to log - contains no secrets. */
export function identityLabels(): string[] {
  return [...identities.values()].map((i) => i.label);
}

/**
 * Constant-time string compare. Length is not secret (our tokens are fixed length),
 * but the bytes are, so only equal-length buffers are compared.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Resolve a Google-verified email (OAuth path). The domain check has already happened.
 * Returns null when the email may not use this server.
 */
export function authenticateEmail(email: string): AuthResult {
  const key = email.trim().toLowerCase();
  const identity = emailIdentities.get(key);
  if (identity) return { ok: true, identity, label: `${identity.label} <${key}>` };
  if (unmappedPolicy === "shared") return { ok: true, identity: null, label: `shared <${key}>` };
  return { ok: false };
}

/** Emails mapped for OAuth. Safe to log - contains no secrets. */
export function oauthEmails(): string[] {
  return [...emailIdentities.keys()];
}

export function oauthUnmappedPolicy(): string {
  return unmappedPolicy;
}

export type AuthResult =
  | { ok: true; identity: WpIdentity | null; label: string }
  | { ok: false };

/**
 * Resolve a presented token.
 *
 * Returns `identity: null` for the legacy shared token, meaning "fall back to the
 * env-var credentials" - deliberately distinct from a failure.
 */
export function authenticate(token: string | null | undefined): AuthResult {
  if (!token) return { ok: false };

  if (legacyToken && safeEqual(token, legacyToken)) {
    return { ok: true, identity: null, label: "shared" };
  }

  for (const [candidate, identity] of identities) {
    if (safeEqual(token, candidate)) {
      return { ok: true, identity, label: identity.label };
    }
  }

  return { ok: false };
}
