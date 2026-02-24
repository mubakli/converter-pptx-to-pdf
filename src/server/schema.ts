/**
 * schema.ts — Centralized Zod schemas for Project Antigravity
 *
 * Rules enforced here:
 *  1. Every external input (file uploads, API params) is strictly validated.
 *  2. "any" types are forbidden — all schemas are explicit and narrow.
 *  3. Sanitisation helpers live alongside their schemas (Single Responsibility).
 *  4. Output schemas validate server responses to prevent data leakage.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Allowed file extensions for upload (validated in BOTH schema & route) */
export const ALLOWED_EXTENSIONS = [".ppt", ".pptx"] as const;

/** Hard cap per request — prevents memory exhaustion / DoS */
export const MAX_FILES_PER_REQUEST = 10;

/** 100 MB — absolute ceiling; LibreOffice hangs on gigantic files */
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

/** UUIDv4 regex — used wherever we accept jobId strings */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Primitives & reusable atoms
// ---------------------------------------------------------------------------

/**
 * Safe filename — strips path traversal sequences and restricts characters.
 * Prevents:  ../../../etc/passwd  |  %2e%2e%2f  |  shell metacharacters
 */
export const SafeFilenameSchema = z
  .string()
  .min(1, "Filename cannot be empty")
  .max(255, "Filename too long")
  .regex(
    /^[a-zA-Z0-9_\-. ]+\.pptx?$/i,
    "Filename contains forbidden characters or extension"
  )
  .transform((name) =>
    // Strip any remaining path separators as a defence-in-depth measure
    name.replace(/[/\\]/g, "")
  );

/** Strict UUIDv4 — rejects anything that isn't a canonical job identifier */
export const JobIdSchema = z
  .string()
  .regex(UUID_V4_REGEX, "Invalid job ID format");

/** Batch size — only small positive integers accepted */
export const BatchSizeSchema = z.number().int().min(1).max(20).default(3);

// ---------------------------------------------------------------------------
// Upload / Conversion schemas
// ---------------------------------------------------------------------------

/**
 * Validated representation of a single uploaded file.
 * Use this after extracting files from FormData.
 */
export const UploadedFileSchema = z.object({
  /** Original file name — sanitised via SafeFilenameSchema */
  name: SafeFilenameSchema,
  /** Size in bytes — bounded to prevent DoS */
  size: z
    .number()
    .int()
    .positive()
    .max(MAX_FILE_SIZE_BYTES, `File exceeds ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB limit`),
  /** MIME‐type from browser (informational; actual extension is the authority) */
  mimeType: z
    .string()
    .refine(
      (m) =>
        [
          "application/vnd.ms-powerpoint",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "application/octet-stream", // some browsers send this for both
        ].includes(m),
      { message: "Invalid MIME type — only PowerPoint files are accepted" }
    ),
});

export type UploadedFile = z.infer<typeof UploadedFileSchema>;

/**
 * Conversion job request — validated against the tRPC router input.
 */
export const ConversionRequestSchema = z.object({
  batchSize: BatchSizeSchema,
});

export type ConversionRequest = z.infer<typeof ConversionRequestSchema>;

// ---------------------------------------------------------------------------
// Job Status schemas (tRPC outputs — prevents data leakage)
// ---------------------------------------------------------------------------

export const JobStatusEnum = z.enum(["pending", "running", "done", "error"]);
export type JobStatusEnum = z.infer<typeof JobStatusEnum>;

/** Response returned for a pending job */
export const PendingJobResponseSchema = z.object({
  status: z.literal("pending"),
  position: z.number().int().min(1),
  estimatedWaitSeconds: z.number().nonnegative().optional(),
});

/** Response returned while a job is running */
export const RunningJobResponseSchema = z.object({
  status: z.literal("running"),
});

/** Response returned when a job completed successfully */
export const DoneJobResponseSchema = z.object({
  status: z.literal("done"),
  fileCount: z.number().int().min(1),
  downloadUrl: z
    .string()
    .url()
    .or(z.string().startsWith("/api/")) // relative internal URLs
    .refine(
      (u) => !u.includes(".."),
      "Download URL contains path traversal"
    ),
});

/** Response returned when a job failed */
export const ErrorJobResponseSchema = z.object({
  status: z.literal("error"),
  /** Never leak stack traces or internal paths — only human-readable messages */
  message: z
    .string()
    .transform((m) => sanitizeErrorMessage(m).slice(0, 256)),
});

/** Discriminated union covering all possible job status responses */
export const JobStatusResponseSchema = z.discriminatedUnion("status", [
  PendingJobResponseSchema,
  RunningJobResponseSchema,
  DoneJobResponseSchema,
  ErrorJobResponseSchema,
]);

export type JobStatusResponse = z.infer<typeof JobStatusResponseSchema>;

// ---------------------------------------------------------------------------
// Health endpoint schema
// ---------------------------------------------------------------------------

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "error"]),
  timestamp: z.string().datetime(),
  ram_usage: z.string(),
  directories: z.object({
    girdiler: z.boolean(),
    ciktilar: z.boolean(),
  }),
  queue: z.object({
    running: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    maxConcurrent: z.number().int().min(1),
  }),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ---------------------------------------------------------------------------
// Rate-limit state schema (purely internal — not sent to clients)
// ---------------------------------------------------------------------------

export const RateLimitEntrySchema = z.object({
  count: z.number().int().nonnegative(),
  windowStart: z.number(), // epoch ms
});

export type RateLimitEntry = z.infer<typeof RateLimitEntrySchema>;

// ---------------------------------------------------------------------------
// Sanitisation helpers
// ---------------------------------------------------------------------------

/**
 * Strips HTML tags and JS event-handler attributes from any string.
 * Applied to all text that may be reflected back to the browser (XSS defence).
 */
export function sanitizeString(input: string): string {
  return input
    .replace(/<[^>]*>/g, "") // strip HTML tags
    .replace(/javascript\s*:/gi, "") // strip inline JS protocols
    .replace(/on\w+\s*=/gi, "") // strip event handlers
    .trim();
}

/**
 * Sanitises error messages before exposing them in API responses.
 * Prevents path disclosure, stack trace leakage, and internal variable names.
 */
export function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/\/[^\s]*/g, "[path]") // redact file paths
    .replace(/\bat\s+\S+/g, "") // strip stack frames
    .trim()
    .slice(0, 256);
}

/**
 * Validates that a file extension is in the allow-list.
 * Called as an additional guard even after Zod validation.
 */
export function isAllowedExtension(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}
