/**
 * trpc-context.ts — Hardened tRPC context factory for Project Antigravity
 *
 * Responsibilities:
 *  1. Rate-limit enforcement (per-IP, sliding window)
 *  2. Request metadata extraction (IP, User-Agent) — stored in context
 *  3. API-Key-based authentication for protected procedures
 *
 * NOTE: This project has no database, so "Least Privilege" is enforced
 * at the process level (LibreOffice runs in a temp dir per job, cleaned up
 * immediately after use).
 */

import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { RateLimitEntry } from "./schema";

// ---------------------------------------------------------------------------
// Rate Limiter (in-process, no Redis dep — sufficient for single-instance)
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 20; // max conversion requests per IP per window

const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Returns true if the IP is ALLOWED (not throttled).
 * Sliding-window counter — resets after RATE_LIMIT_WINDOW_MS.
 */
export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // New window
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false; // throttled
  }

  entry.count++;
  return true;
}

/** Expose current limit stats for the health endpoint */
export function getRateLimitStats(ip: string): { remaining: number; windowResetMs: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    return { remaining: RATE_LIMIT_MAX_REQUESTS, windowResetMs: RATE_LIMIT_WINDOW_MS };
  }
  return {
    remaining: Math.max(0, RATE_LIMIT_MAX_REQUESTS - entry.count),
    windowResetMs: RATE_LIMIT_WINDOW_MS - (now - entry.windowStart),
  };
}

// Purge stale entries every 5 minutes to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  Array.from(rateLimitStore.entries()).forEach(([ip, entry]) => {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitStore.delete(ip);
    }
  });
}, 5 * 60_000);

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface TRPCContext {
  /** Caller IP — used for rate limiting and audit logging */
  ip: string;
  /** Raw User-Agent string (informational / anomaly detection) */
  userAgent: string;
  /** True when a valid API-Key header is present */
  isAuthenticated: boolean;
}

/**
 * Extracts the real client IP from common proxy headers.
 * Falls back to "unknown" — never throws.
 */
function extractIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0].trim();
    // Basic sanity check — IPv4/IPv6 chars only
    if (/^[\d.:a-fA-F]+$/.test(first)) return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp && /^[\d.:a-fA-F]+$/.test(realIp.trim())) return realIp.trim();
  return "unknown";
}

/**
 * Validates the API key header for protected procedures.
 *
 * The key is compared with `crypto.timingSafeEqual` to prevent
 * timing-attack based enumeration of valid keys.
 */
function validateApiKey(req: Request): boolean {
  const provided = req.headers.get("x-api-key") ?? "";
  const expected = process.env.API_SECRET_KEY;

  if (!expected || !provided) return false;

  try {
    const { timingSafeEqual, createHash } = require("crypto") as typeof import("crypto");
    // Hash both sides so they are the same byte-length regardless of input
    const a = createHash("sha256").update(provided).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** tRPC context factory — called for every request */
export async function createContext({
  req,
}: FetchCreateContextFnOptions): Promise<TRPCContext> {
  return {
    ip: extractIp(req),
    userAgent: (req.headers.get("user-agent") ?? "").slice(0, 256), // cap length
    isAuthenticated: validateApiKey(req),
  };
}
