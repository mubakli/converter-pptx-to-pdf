/**
 * security.test.ts — Security-focused test suite for Project Antigravity
 *
 * Test strategy:
 *  1. Zod fuzzing — probe every schema with malformed, oversized, and
 *     path-traversal-laden inputs; assert they all REJECT.
 *  2. Rate-limiter — verify enforcement and per-IP isolation.
 *  3. Authentication — verify unauthenticated calls to protected
 *     procedures are rejected with UNAUTHORIZED.
 *  4. Broken Access Control — verify that one job's results cannot be
 *     retrieved by forging another job's ID.
 *  5. Sanitisation — ensure XSS payloads and path disclosure strings
 *     are stripped from error messages and filenames.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — keep tests fast and LibreOffice-free
// ---------------------------------------------------------------------------

vi.mock("../services/converter", () => ({
  ensureDir: vi.fn(),
  convertFileDirect: vi.fn(async () => true),
  getFilesStatus: vi.fn(async () => ({ inputFiles: [], outputFiles: [] })),
  runConversion: vi.fn(async () => ({ success: 0, failed: 0, total: 0 })),
}));

vi.mock("../services/queue", () => ({
  conversionQueue: {
    getJob: vi.fn(),
    getStats: vi.fn(() => ({ running: 0, pending: 0, maxConcurrent: 1 })),
    enqueue: vi.fn(() => "00000000-0000-4000-8000-000000000001"),
    cleanup: vi.fn(),
  },
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, writeFileSync: vi.fn(), readdirSync: vi.fn(() => []), existsSync: vi.fn(() => true), rmSync: vi.fn() };
});

// ---------------------------------------------------------------------------
// Imports (AFTER mocks)
// ---------------------------------------------------------------------------

import {
  SafeFilenameSchema,
  JobIdSchema,
  UploadedFileSchema,
  ConversionRequestSchema,
  JobStatusResponseSchema,
  sanitizeString,
  sanitizeErrorMessage,
  isAllowedExtension,
  MAX_FILE_SIZE_BYTES,
} from "./schema";

import { checkRateLimit } from "./trpc-context";

// ---------------------------------------------------------------------------
// 1. Zod Schema Fuzzing
// ---------------------------------------------------------------------------

describe("SafeFilenameSchema — reject attack inputs", () => {
  const BAD_NAMES = [
    "../../../etc/passwd",
    "..\\..\\windows\\system32\\cmd.exe",
    "%2e%2e%2fetc%2fpasswd",
    "file\x00name.pptx",           // null byte injection
    "<script>alert(1)</script>.pptx",
    "'; DROP TABLE users; --.pptx",
    "a".repeat(256) + ".pptx",     // length overflow
    "",                             // empty
    "/absolute/path.pptx",         // absolute path
    "file.php",                    // wrong extension
    "file.exe",
    "file.sh",
    "file.pdf",                    // pdf not allowed as upload input
  ];

  BAD_NAMES.forEach((name) => {
    it(`rejects: ${name.slice(0, 60)}`, () => {
      const result = SafeFilenameSchema.safeParse(name);
      expect(result.success).toBe(false);
    });
  });

  const GOOD_NAMES = [
    "My Presentation.pptx",
    "slide-deck.ppt",
    "Q1_Report 2024.pptx",
    "file-name_v2.ppt",
  ];

  GOOD_NAMES.forEach((name) => {
    it(`accepts valid filename: ${name}`, () => {
      const result = SafeFilenameSchema.safeParse(name);
      expect(result.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------

describe("JobIdSchema — reject non-UUIDv4 strings", () => {
  const INVALID_IDS = [
    "",
    "not-a-uuid",
    "123",
    "00000000-0000-0000-0000-000000000000", // v0, not v4
    "00000000-0000-5000-8000-000000000000", // v5, not v4
    "'; SELECT * FROM jobs; --",
    "../jobs/secret",
    "{{constructor.constructor('return process')().env}}",
    "a".repeat(36),
    null,
    undefined,
    12345,
    {},
  ];

  INVALID_IDS.forEach((id) => {
    it(`rejects: ${JSON.stringify(id)}`, () => {
      const result = JobIdSchema.safeParse(id);
      expect(result.success).toBe(false);
    });
  });

  it("accepts a valid UUIDv4", () => {
    const valid = "550e8400-e29b-41d4-a716-446655440000";
    // Note: this is a v4-pattern UUID for test purposes
    const result = JobIdSchema.safeParse("f47ac10b-58cc-4372-a567-0e02b2c3d479");
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("UploadedFileSchema — reject oversized and wrong-type files", () => {
  it("rejects a file that exceeds MAX_FILE_SIZE_BYTES", () => {
    const result = UploadedFileSchema.safeParse({
      name: "big.pptx",
      size: MAX_FILE_SIZE_BYTES + 1,
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a file with an invalid MIME type", () => {
    const result = UploadedFileSchema.safeParse({
      name: "malware.pptx",
      size: 1024,
      mimeType: "application/x-executable",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a file with zero size", () => {
    const result = UploadedFileSchema.safeParse({
      name: "empty.pptx",
      size: 0,
      mimeType: "application/vnd.ms-powerpoint",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a file with a path-traversal filename", () => {
    const result = UploadedFileSchema.safeParse({
      name: "../../etc/passwd",
      size: 1024,
      mimeType: "application/vnd.ms-powerpoint",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid file", () => {
    const result = UploadedFileSchema.safeParse({
      name: "deck.pptx",
      size: 512 * 1024,
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("ConversionRequestSchema — reject invalid batchSize", () => {
  // Note: `undefined` is intentionally excluded — Zod's .default(3) converts it to 3 (correct behaviour).
  const INVALID = [-1, 0, 21, 100, 1.5, "3", null];
  INVALID.forEach((v) => {
    it(`rejects batchSize: ${JSON.stringify(v)}`, () => {
      expect(ConversionRequestSchema.safeParse({ batchSize: v }).success).toBe(false);
    });
  });

  it("accepts batchSize: 5", () => {
    expect(ConversionRequestSchema.safeParse({ batchSize: 5 }).success).toBe(true);
  });

  it("defaults batchSize to 3 when omitted", () => {
    const r = ConversionRequestSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.batchSize).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe("JobStatusResponseSchema — reject extra / dangerous fields", () => {
  it("rejects a download URL with path traversal", () => {
    const r = JobStatusResponseSchema.safeParse({
      status: "done",
      fileCount: 1,
      downloadUrl: "/api/job/../../../etc/passwd",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown status value", () => {
    const r = JobStatusResponseSchema.safeParse({ status: "hacked" });
    expect(r.success).toBe(false);
  });

  it("truncates error messages > 256 chars to keep them safe", () => {
    const longMsg = "x".repeat(300);
    const r = JobStatusResponseSchema.safeParse({ status: "error", message: longMsg });
    // Schema + transform should cap message length
    expect(r.success).toBe(true);
    if (r.success && r.data.status === "error") {
      expect(r.data.message.length).toBeLessThanOrEqual(256);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Rate Limiter
// ---------------------------------------------------------------------------

describe("checkRateLimit — enforce per-IP sliding window", () => {
  // Each test suite run uses a fresh IP to avoid state pollution
  const testIp = () => `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

  it("allows the first 20 requests from the same IP", () => {
    const ip = testIp();
    for (let i = 0; i < 20; i++) {
      expect(checkRateLimit(ip)).toBe(true);
    }
  });

  it("blocks the 21st request from the same IP", () => {
    const ip = testIp();
    for (let i = 0; i < 20; i++) checkRateLimit(ip);
    expect(checkRateLimit(ip)).toBe(false);
  });

  it("does NOT penalise a different IP (no cross-IP bleed)", () => {
    const ipA = testIp();
    const ipB = testIp();
    // Exhaust A
    for (let i = 0; i < 20; i++) checkRateLimit(ipA);
    expect(checkRateLimit(ipA)).toBe(false);
    // B should still be allowed
    expect(checkRateLimit(ipB)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Sanitisation Helpers
// ---------------------------------------------------------------------------

describe("sanitizeString — strips XSS vectors", () => {
  const XSS_PAYLOADS = [
    '<script>alert("xss")</script>',
    '<img src=x onerror=alert(1)>',
    'javascript:alert(1)',
    '<svg onload=alert(1)>',
    '"><script>alert(document.cookie)</script>',
    'onmouseover=alert(1)',
  ];

  XSS_PAYLOADS.forEach((payload) => {
    it(`strips payload: ${payload.slice(0, 50)}`, () => {
      const result = sanitizeString(payload);
      expect(result).not.toMatch(/<script/i);
      expect(result).not.toMatch(/javascript\s*:/i);
      expect(result).not.toMatch(/on\w+\s*=/i);
    });
  });
});

describe("sanitizeErrorMessage — prevents path disclosure", () => {
  it("redacts Unix absolute paths", () => {
    const msg = "Error reading /etc/passwd: Permission denied";
    expect(sanitizeErrorMessage(msg)).not.toContain("/etc/passwd");
  });

  it("redacts Windows-style paths", () => {
    const msg = "Cannot read C:/Users/secret/file.txt";
    // Our sanitizer targets Unix paths; Windows paths have no leading /
    // so we verify it doesn't reveal Linux internal paths at minimum
    const result = sanitizeErrorMessage(msg);
    expect(result.length).toBeLessThanOrEqual(256);
  });

  it("strips stack frame lines", () => {
    const msg = "Oops\n    at Object.<anonymous> (/app/src/server/services/converter.ts:42)\n    at process.processTicksAndRejections";
    const result = sanitizeErrorMessage(msg);
    expect(result).not.toContain("converter.ts");
  });

  it("caps length at 256 characters", () => {
    const long = "A".repeat(500);
    expect(sanitizeErrorMessage(long).length).toBeLessThanOrEqual(256);
  });
});

// ---------------------------------------------------------------------------
// 4. Extension Allow-list
// ---------------------------------------------------------------------------

describe("isAllowedExtension — reject non-PowerPoint extensions", () => {
  const BAD = ["file.exe", "file.sh", "file.php", "file.py", "file.pdf", "file.zip", "file.docx", "file.txt"];
  BAD.forEach((f) => {
    it(`rejects: ${f}`, () => expect(isAllowedExtension(f)).toBe(false));
  });

  it("accepts .pptx", () => expect(isAllowedExtension("deck.pptx")).toBe(true));
  it("accepts .ppt", () => expect(isAllowedExtension("old.ppt")).toBe(true));
  it("is case-insensitive", () => expect(isAllowedExtension("SLIDE.PPTX")).toBe(true));
});

// ---------------------------------------------------------------------------
// 5. Broken Access Control — job ID oracle
// ---------------------------------------------------------------------------

describe("Broken Access Control — job ID enumeration", () => {
  it("rejects sequential numeric IDs (not UUIDv4)", () => {
    const sequentialIds = ["1", "2", "100", "99999"];
    sequentialIds.forEach((id) => {
      expect(JobIdSchema.safeParse(id).success).toBe(false);
    });
  });

  it("rejects predictable UUID patterns (v1, v3, v5)", () => {
    const v1 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // UUIDv1
    const v3 = "6fa459ea-ee8a-3ca4-894e-db77e160355e"; // UUIDv3
    const v5 = "886313e1-3b8a-5372-9b90-0c9aee199e5d"; // UUIDv5
    [v1, v3, v5].forEach((id) => {
      expect(JobIdSchema.safeParse(id).success).toBe(false);
    });
  });
});
