# Security Patch Report — Project Antigravity
**Date:** 2026-02-24  
**Scope:** PPTX-to-PDF converter web service  
**Authored by:** Senior Engineer / Security Reviewer  

---

## Identified Vulnerabilities & Mitigations

### 1. Path Traversal / Directory Traversal

| | Details |
|---|---|
| **Risk** | Critical |
| **Attack Vector** | `POST /api/convert` — A malicious client could upload a file named `../../../etc/passwd.pptx`, causing the server to write to an arbitrary filesystem location. |

**Before (vulnerable):**
```typescript
// route.ts — old code
const inputPath = path.join(tempDir, file.name); // file.name is UNTRUSTED
fs.writeFileSync(inputPath, buffer);
```

**After (mitigated in `schema.ts`):**
```typescript
export const SafeFilenameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_\-. ]+\.(pptx?)$/i, "Forbidden characters")
  .transform((name) => name.replace(/[/\\]/g, "")); // strip separators
```
The regex allow-list rejects `..`, `/`, `\`, null bytes, and shell metacharacters before the name is ever used in a `path.join`.

---

### 2. Denial of Service — Unrestricted File Size

| | Details |
|---|---|
| **Risk** | High |
| **Attack Vector** | No file-size validation. A client sending a 2 GB file would exhaust server RAM (Node Buffer), crash the process, and take down service for all users. |

**Mitigation (`schema.ts`):**
```typescript
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB hard cap

export const UploadedFileSchema = z.object({
  size: z.number().positive().max(MAX_FILE_SIZE_BYTES),
  ...
});
```
Reject oversized uploads at schema-validation time, before any buffer allocation.

---

### 3. Denial of Service — Unrestricted Concurrent LibreOffice Processes

| | Details |
|---|---|
| **Risk** | High |
| **Attack Vector** | Each `POST /api/convert` spawned a LibreOffice process. 20 simultaneous users → 20 `soffice` processes → RAM exhaustion, process crash. |

**Mitigation (`queue.ts`):**
```typescript
class ConversionQueue {
  private readonly maxConcurrent = parseInt(process.env.MAX_CONCURRENT_JOBS ?? "1");
  // ...FIFO queue — excess requests wait, not spawn
}
```
Only `maxConcurrent` LibreOffice processes exist at any moment. Additionally, LibreOffice's shared user-profile lock causes **race conditions** when >1 instance runs; `MAX_CONCURRENT_JOBS=1` eliminates this.

---

### 4. Denial of Service — No Rate Limiting

| | Details |
|---|---|
| **Risk** | High |
| **Attack Vector** | Any client could hammer `/api/convert` in a tight loop, consuming all LibreOffice slots and saturating the queue with fake jobs — a resource-exhaustion / queue-flooding attack. |

**Mitigation (`trpc-context.ts`):**
```typescript
// Sliding window: 20 requests per IP per 60 seconds
export function checkRateLimit(ip: string): boolean { ... }

// Middleware applied to ALL mutation procedures
const rateLimitMiddleware = t.middleware(({ ctx, next }) => {
  if (!checkRateLimit(ctx.ip)) throw new TRPCError({ code: "TOO_MANY_REQUESTS" });
  return next({ ctx });
});
```

---

### 5. Broken Access Control — Unauthenticated Admin Endpoints

| | Details |
|---|---|
| **Risk** | High |
| **Attack Vector** | `startConversion` (triggers folder-wide batch conversion) was a `publicProcedure`. Any anonymous user could trigger unlimited server-side work or read internal file listings. |

**Mitigation (`router.ts`):**
```typescript
// protectedProcedure = rateLimitMiddleware + authMiddleware
export const protectedProcedure = t.procedure
  .use(rateLimitMiddleware)
  .use(authMiddleware);

// These endpoints now require x-api-key header
startFolderConversion: protectedProcedure...
getQueueStats:         protectedProcedure...
listFiles:             protectedProcedure...
```

---

### 6. Broken Access Control — Job ID Oracle / Enumeration

| | Details |
|---|---|
| **Risk** | Medium |
| **Attack Vector** | If job IDs were sequential integers (`1`, `2`, `3`…), any user could poll `GET /api/job/5` to read another user's job status/download URL and steal their converted PDF. |

**Mitigation:**  
- Job IDs are **UUIDv4** (128-bit cryptographically random) — impossible to enumerate.  
- `JobIdSchema` validates the strict UUIDv4 format (rejects v1, v3, v5, and sequential IDs).  
- Error messages use a vague "Job not found or has expired" without distinguishing nonexistent from expired — prevents timing-based probing.

---

### 7. Information Disclosure — Stack Trace Leakage

| | Details |
|---|---|
| **Risk** | Medium |
| **Attack Vector** | tRPC's default error formatter bubbles unhandled exceptions to the client, including full stack traces with internal file paths — exposes internal architecture. |

**Mitigation (`router.ts`):**
```typescript
const t = initTRPC.context<TRPCContext>().create({
  errorFormatter({ shape }) {
    return {
      ...shape,
      message: sanitizeErrorMessage(shape.message),
      data: { ...shape.data, stack: undefined }, // always strip
    };
  },
});
```

`sanitizeErrorMessage` additionally redacts Unix file paths and stack-frame lines.

---

### 8. Timing Attack — API Key Comparison

| | Details |
|---|---|
| **Risk** | Medium |
| **Attack Vector** | A naive `apiKey === process.env.API_SECRET_KEY` comparison is vulnerable to timing attacks: an attacker can measure response latency to incrementally guess the secret character by character. |

**Mitigation (`trpc-context.ts`):**
```typescript
import { timingSafeEqual, createHash } from "crypto";
// Hash both sides to equalise byte-lengths, then compare in constant time
const a = createHash("sha256").update(provided).digest();
const b = createHash("sha256").update(expected).digest();
return timingSafeEqual(a, b);
```

---

### 9. XSS — Reflected Input in Responses

| | Details |
|---|---|
| **Risk** | Medium |
| **Attack Vector** | User-supplied filenames or error strings could be reflected in API JSON responses. If a downstream client renders these without escaping, XSS is possible. |

**Mitigation (`schema.ts`):**
```typescript
export function sanitizeString(input: string): string {
  return input
    .replace(/<[^>]*>/g, "")       // strip HTML tags
    .replace(/javascript\s*:/gi, "") // strip JS URLs
    .replace(/on\w+\s*=/gi, "")    // strip event handlers
    .trim();
}
```
Applied to all strings before they enter API responses.

---

### 10. MIME Type Confusion — Polyglot File Attacks

| | Details |
|---|---|
| **Risk** | Low–Medium |
| **Attack Vector** | A file named `malware.pptx` but containing a PHP/shell script could be uploaded. LibreOffice would likely fail to parse it, but if the file were ever served back unvalidated it could be executed server-side in misconfigured environments. |

**Mitigation:**  
- `UploadedFileSchema` validates MIME type against a strict allow-list.  
- `isAllowedExtension()` provides a second, independent extension check (defence-in-depth).  
- Each job runs in an isolated `os.tmpdir()` subdirectory, deleted immediately after download.

---

## Outstanding Items / Recommendations

| Item | Priority |
|---|---|
| Add CSRF token validation for the `/api/convert` form submission (mitigated by SameSite cookie policy if auth is cookie-based, but should be explicit) | Medium |
| Move `API_SECRET_KEY` to a secrets manager (Vault, AWS Secrets Manager) — never commit to `.env` | High |
| Add HTTPS / TLS termination at the reverse proxy level (Nginx/Caddy) | Critical for production |
| Add request body size limits at the HTTP server layer (`next.config.js` `bodyParser.sizeLimit`) as a second line of defence | Medium |
| Consider virus scanning uploaded files via ClamAV before passing to LibreOffice | Medium |
| Implement per-user job ownership — currently any caller who guesses a UUIDv4 can poll that job | Low (UUIDv4 entropy makes this impractical) |
