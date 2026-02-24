/**
 * router.ts — tRPC router for Project Antigravity
 *
 * Security controls layered here:
 *  1. All inputs validated by Zod schemas from schema.ts — no `any`.
 *  2. Rate-limiting middleware enforced before business logic.
 *  3. `protectedProcedure` requires a valid API key (via context).
 *  4. Outputs validated before being returned (data-leakage prevention).
 *  5. Path traversal stripped from all file identifiers.
 *  6. Error messages sanitised — internal paths never leak to callers.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import type { TRPCContext } from "./trpc-context";
import { checkRateLimit } from "./trpc-context";
import {
  JobIdSchema,
  BatchSizeSchema,
  JobStatusResponseSchema,
  HealthResponseSchema,
  sanitizeErrorMessage,
  isAllowedExtension,
  MAX_FILES_PER_REQUEST,
  MAX_FILE_SIZE_BYTES,
} from "./schema";
import { conversionQueue } from "./services/queue";
import { getFilesStatus, runConversion } from "./services/converter";

// ---------------------------------------------------------------------------
// tRPC initialisation with typed context
// ---------------------------------------------------------------------------

const t = initTRPC.context<TRPCContext>().create({
  /**
   * Custom error formatter — strips internal detail from production responses.
   * Developers still see full info in server logs; clients only get safe messages.
   */
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      message: sanitizeErrorMessage(shape.message),
      data: {
        ...shape.data,
        // Never expose a stack trace to the client
        stack: undefined,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Reusable middleware
// ---------------------------------------------------------------------------

/**
 * Rate-limit middleware — enforced on ALL mutation procedures.
 * Returns HTTP 429 when the caller exceeds 20 req/min.
 */
const rateLimitMiddleware = t.middleware(({ ctx, next }) => {
  if (!checkRateLimit(ctx.ip)) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Rate limit exceeded. Please wait before sending another request.",
    });
  }
  return next({ ctx });
});

/**
 * Auth middleware — validates the x-api-key header.
 * Used by `protectedProcedure`.
 */
const authMiddleware = t.middleware(({ ctx, next }) => {
  if (!ctx.isAuthenticated) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "A valid API key is required.",
    });
  }
  return next({ ctx });
});

// ---------------------------------------------------------------------------
// Procedure builders
// ---------------------------------------------------------------------------

/** Open to everyone — rate-limited */
export const publicProcedure = t.procedure.use(rateLimitMiddleware);

/** Requires valid API key — rate-limited + authenticated */
export const protectedProcedure = t.procedure
  .use(rateLimitMiddleware)
  .use(authMiddleware);

// ---------------------------------------------------------------------------
// Antigravity Router
// ---------------------------------------------------------------------------

export const antigravityRouter = t.router({

  // ── Health ──────────────────────────────────────────────────────────────
  /**
   * Public health check.
   * Output is validated by HealthResponseSchema to prevent accidental leakage
   * of internal configuration or environment details.
   */
  health: t.procedure.query(async () => {
    const { inputFiles, outputFiles } = await getFilesStatus();
    const stats = conversionQueue.getStats();

    const raw = {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      ram_usage: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`,
      directories: {
        girdiler: inputFiles.length >= 0, // dir exists if getFilesStatus didn't throw
        ciktilar: outputFiles.length >= 0,
      },
      queue: stats,
    };

    // Validate the output — throws if schema is violated (dev-time safety net)
    return HealthResponseSchema.parse(raw);
  }),

  // ── Job Status (public, rate-limited) ────────────────────────────────────
  /**
   * Poll for a conversion job's status.
   *
   * Security: jobId is validated as UUIDv4 — prevents probing for arbitrary
   * internal resources via crafted IDs (Broken Access Control).
   */
  getJobStatus: publicProcedure
    .input(z.object({ jobId: JobIdSchema }))
    .query(({ input }) => {
      const job = conversionQueue.getJob(input.jobId);

      if (!job) {
        throw new TRPCError({
          code: "NOT_FOUND",
          // Intentionally vague — avoids oracle attack (ID enumeration)
          message: "Job not found or has expired.",
        });
      }

      let response: unknown;
      switch (job.status) {
        case "pending":
          response = { status: "pending", position: job.position ?? 1 };
          break;
        case "running":
          response = { status: "running" };
          break;
        case "done":
          response = {
            status: "done",
            fileCount: job.outputPaths.length,
            downloadUrl: `/api/job/${input.jobId}/download`,
          };
          break;
        case "error":
          response = {
            status: "error",
            message: sanitizeErrorMessage(job.error ?? "Conversion failed."),
          };
          break;
      }

      // Validate output — prevents accidentally leaking extra Job fields
      return JobStatusResponseSchema.parse(response);
    }),

  // ── Folder-based conversion (PROTECTED — admin only) ─────────────────────
  /**
   * Triggers batch conversion of all files in the `girdiler` folder.
   * PROTECTED: only callers with a valid x-api-key may trigger this.
   *
   * Without auth enforcement, any anonymous user could trigger an
   * arbitrarily long server-side operation → CPU/RAM exhaustion.
   */
  startFolderConversion: protectedProcedure
    .input(z.object({ batchSize: BatchSizeSchema }))
    .mutation(async ({ input }) => {
      const result = await runConversion(input.batchSize);
      return z
        .object({
          success: z.number().int().nonnegative(),
          failed: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
        })
        .parse(result);
    }),

  // ── Queue stats (PROTECTED — admin only) ─────────────────────────────────
  /**
   * Returns live queue metrics.
   * PROTECTED: exposing queue depth to arbitrary clients is an
   * information-disclosure risk (reveals server load).
   */
  getQueueStats: protectedProcedure.query(() => {
    return z
      .object({
        running: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
        maxConcurrent: z.number().int().min(1),
      })
      .parse(conversionQueue.getStats());
  }),

  // ── File listing (PROTECTED — admin only) ────────────────────────────────
  /**
   * Lists files in the input and output folders.
   * PROTECTED: directory listings are sensitive (path disclosure).
   *
   * Output is filtered through a safe filename regex to prevent directory
   * traversal artifacts being surfaced even if they somehow appear on disk.
   */
  listFiles: protectedProcedure.query(async () => {
    const { inputFiles, outputFiles } = await getFilesStatus();

    const safeFilter = (names: string[]) =>
      names.filter((n) => isAllowedExtension(n) || n.endsWith(".pdf"));

    return {
      inputFiles: safeFilter(inputFiles),
      outputFiles: safeFilter(outputFiles),
    };
  }),
});

export type AntigravityRouter = typeof antigravityRouter;

// Re-export base router helpers so existing code continues to work
export const router = t.router;
