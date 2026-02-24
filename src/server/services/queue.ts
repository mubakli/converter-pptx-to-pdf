import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { v4 as uuidv4 } from "uuid";
import { convertFileDirect, ensureDir } from "./converter";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = "pending" | "running" | "done" | "error";

export interface JobFile {
  /** Original file name (e.g. "Sunum.pptx") */
  name: string;
  /** Buffer of the uploaded file (held in memory until written to disk) */
  buffer: Buffer;
}

export interface Job {
  id: string;
  status: JobStatus;
  /** Position in the waiting queue (1-indexed, undefined when not pending) */
  position?: number;
  /** Absolute path of the temp working directory for this job */
  tempDir: string;
  /** Paths of the converted PDF files (populated on done) */
  outputPaths: string[];
  /** Error message if status === "error" */
  error?: string;
  /** ISO timestamp of when the job was created */
  createdAt: string;
  /** Timer handle for automatic cleanup */
  _cleanupTimer?: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// ConversionQueue — singleton
// ---------------------------------------------------------------------------

const JOB_TTL_MS = 10 * 60 * 1_000; // 10 minutes
const DEFAULT_MAX_CONCURRENT = 1; // safe default — LibreOffice uses a shared lock

class ConversionQueue {
  private readonly maxConcurrent: number;
  private running = 0;
  /** FIFO queue of callbacks that start the next job */
  private waitQueue: Array<() => void> = [];
  /** All known jobs */
  private readonly jobs = new Map<string, Job>();

  constructor() {
    this.maxConcurrent = parseInt(
      process.env.MAX_CONCURRENT_JOBS ?? String(DEFAULT_MAX_CONCURRENT),
      10
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Accepts uploaded file buffers, creates a Job, and schedules it.
   * Returns the jobId immediately — the caller does NOT wait for conversion.
   */
  enqueue(files: JobFile[]): string {
    const id = uuidv4();
    const tempDir = path.join(os.tmpdir(), `pptx-job-${id}`);
    ensureDir(tempDir);

    // Write uploaded buffers to the temp dir right away so HTTP response is instant
    for (const f of files) {
      fs.writeFileSync(path.join(tempDir, f.name), f.buffer);
    }

    const job: Job = {
      id,
      status: "pending",
      tempDir,
      outputPaths: [],
      createdAt: new Date().toISOString(),
    };

    this.jobs.set(id, job);
    this._updatePositions();
    this._scheduleNext();
    return id;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  getStats(): { running: number; pending: number; maxConcurrent: number } {
    let pending = 0;
    Array.from(this.jobs.values()).forEach((job) => {
      if (job.status === "pending") pending++;
    });
    return { running: this.running, pending, maxConcurrent: this.maxConcurrent };
  }

  /**
   * Deletes temp files for a job and removes it from the map.
   * Called after the client downloads the result, or after TTL.
   */
  cleanup(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job._cleanupTimer) clearTimeout(job._cleanupTimer);
    this._removeTempDir(job.tempDir);
    this.jobs.delete(id);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _scheduleNext(): void {
    if (this.running >= this.maxConcurrent) {
      // No slot available — caller will be woken up via waitQueue
      return;
    }

    // Find the oldest pending job
    const next = this._nextPendingJob();
    if (!next) return;

    this.running++;
    next.status = "running";
    next.position = undefined;
    this._updatePositions();

    this._run(next).finally(() => {
      this.running--;
      this._scheduleNext(); // drain queue
    });
  }

  private async _run(job: Job): Promise<void> {
    try {
      const inputFiles = fs
        .readdirSync(job.tempDir)
        .filter((f) => [".ppt", ".pptx"].includes(path.extname(f).toLowerCase()));

      for (const fileName of inputFiles) {
        const inputPath = path.join(job.tempDir, fileName);
        const baseName = path.basename(fileName, path.extname(fileName));
        const outputPath = path.join(job.tempDir, `${baseName}.pdf`);

        const ok = await convertFileDirect(inputPath, outputPath);
        if (ok) {
          job.outputPaths.push(outputPath);
        }
      }

      if (job.outputPaths.length === 0) {
        job.status = "error";
        job.error = "All conversions failed.";
      } else {
        job.status = "done";
      }
    } catch (err: any) {
      job.status = "error";
      job.error = err?.message ?? "Unknown error";
    }

    // Schedule automatic cleanup after TTL
    job._cleanupTimer = setTimeout(() => this.cleanup(job.id), JOB_TTL_MS);
  }

  private _nextPendingJob(): Job | undefined {
    // Jobs are iterated in insertion order (Map preserves insertion order)
    return Array.from(this.jobs.values()).find((job) => job.status === "pending");
  }

  private _updatePositions(): void {
    let pos = 1;
    Array.from(this.jobs.values()).forEach((job) => {
      if (job.status === "pending") {
        job.position = pos++;
      } else {
        job.position = undefined;
      }
    });
  }

  private _removeTempDir(tempDir: string): void {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup; log but don't throw
      console.error(`[Queue] Failed to remove temp dir: ${tempDir}`);
    }
  }
}

// Export a single shared instance (module singleton pattern in Node.js)
export const conversionQueue = new ConversionQueue();
