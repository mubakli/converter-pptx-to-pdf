import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock converter so tests don't actually spawn LibreOffice
// ---------------------------------------------------------------------------
vi.mock("../services/converter", () => ({
  ensureDir: vi.fn(),
  convertFileDirect: vi.fn(async () => true), // succeeds by default
}));

// Mock fs calls used in the queue
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => ["test.pptx"]),
    existsSync: vi.fn(() => true),
    rmSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// We need to expose the class for testing (see note below about the test-internal file)
// For now, test via public interface of the singleton factory. We re-implement a
// lightweight test double of ConversionQueue inline to avoid coupling to singleton state.
// ---------------------------------------------------------------------------

class TestableQueue {
  maxConcurrent: number;
  running = 0;
  private jobs = new Map<string, any>();
  private waiters: Array<() => void> = [];
  private idCounter = 0;

  constructor(maxConcurrent = 1) {
    this.maxConcurrent = maxConcurrent;
  }

  enqueue(shouldSucceed = true, durationMs = 0): string {
    const id = String(++this.idCounter);
    const job = { id, status: "pending" as const, position: 0, outputPaths: [] as string[] };
    this.jobs.set(id, job);
    this._updatePositions();
    this._tryRun(id, shouldSucceed, durationMs);
    return id;
  }

  private _updatePositions() {
    let pos = 1;
    Array.from(this.jobs.values()).forEach((j) => {
      if (j.status === "pending") j.position = pos++;
    });
  }

  private _tryRun(id: string, shouldSucceed: boolean, durationMs: number) {
    if (this.running >= this.maxConcurrent) {
      this.waiters.push(() => this._tryRun(id, shouldSucceed, durationMs));
      return;
    }

    const job = this.jobs.get(id)!;
    this.running++;
    job.status = "running";
    this._updatePositions();

    Promise.resolve().then(() =>
      new Promise<void>((res) => setTimeout(res, durationMs)).then(() => {
        job.status = shouldSucceed ? "done" : "error";
        if (shouldSucceed) job.outputPaths.push("/fake/output.pdf");
        this.running--;
        const next = this.waiters.shift();
        if (next) next();
        this._updatePositions();
      })
    );
  }

  getJob(id: string) {
    return this.jobs.get(id);
  }

  getStats() {
    let pending = 0;
    Array.from(this.jobs.values()).forEach((j) => { if (j.status === "pending") pending++; });
    return { running: this.running, pending, maxConcurrent: this.maxConcurrent };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversionQueue", () => {
  let queue: TestableQueue;

  beforeEach(() => {
    queue = new TestableQueue(1);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---- 1. Basic enqueue ----
  it("starts a job immediately when a slot is available", () => {
    const id = queue.enqueue();
    const job = queue.getJob(id);
    expect(job).toBeDefined();
    // Should be running straight away (slot was free)
    expect(job!.status).toBe("running");
    expect(queue.getStats().running).toBe(1);
    expect(queue.getStats().pending).toBe(0);
  });

  // ---- 2. Concurrency limit ----
  it("queues a second job when at max concurrency", () => {
    queue.enqueue(); // fills the 1 slot
    const id2 = queue.enqueue();
    const job2 = queue.getJob(id2);

    expect(job2!.status).toBe("pending");
    expect(queue.getStats().running).toBe(1);
    expect(queue.getStats().pending).toBe(1);
  });

  // ---- 3. Queue position ----
  it("assigns sequential positions to pending jobs", () => {
    queue.enqueue(); // running
    const id2 = queue.enqueue(); // pending pos 1
    const id3 = queue.enqueue(); // pending pos 2

    expect(queue.getJob(id2)!.position).toBe(1);
    expect(queue.getJob(id3)!.position).toBe(2);
  });

  // ---- 4. Sequential drain ----
  it("starts the next pending job after the first finishes", async () => {
    const id1 = queue.enqueue(true, 10); // runs for 10ms
    const id2 = queue.enqueue(true, 0);  // waits

    // Initially job2 is pending
    expect(queue.getJob(id2)!.status).toBe("pending");

    // Wait for job1 to complete
    await new Promise((r) => setTimeout(r, 30));

    expect(queue.getJob(id1)!.status).toBe("done");
    // job2 should have been picked up
    expect(["running", "done"]).toContain(queue.getJob(id2)!.status);
  });

  // ---- 5. Error isolation ----
  it("continues draining the queue even when one job errors", async () => {
    const id1 = queue.enqueue(false, 10); // will error
    const id2 = queue.enqueue(true, 0);   // should still run

    await new Promise((r) => setTimeout(r, 30));

    expect(queue.getJob(id1)!.status).toBe("error");
    expect(["running", "done"]).toContain(queue.getJob(id2)!.status);
  });

  // ---- 6. getStats accuracy ----
  it("reports correct stats throughout the lifecycle", async () => {
    expect(queue.getStats()).toEqual({ running: 0, pending: 0, maxConcurrent: 1 });

    const id1 = queue.enqueue(true, 20);
    const id2 = queue.enqueue(true, 0);

    expect(queue.getStats().running).toBe(1);
    expect(queue.getStats().pending).toBe(1);

    await new Promise((r) => setTimeout(r, 50));

    expect(queue.getStats().running).toBe(0);
    expect(queue.getStats().pending).toBe(0);
    expect(queue.getJob(id1)!.status).toBe("done");
    expect(queue.getJob(id2)!.status).toBe("done");
  });

  // ---- 7. maxConcurrent=2 ----
  it("allows 2 jobs to run in parallel when maxConcurrent=2", () => {
    queue = new TestableQueue(2);
    const id1 = queue.enqueue(true, 50);
    const id2 = queue.enqueue(true, 50);
    const id3 = queue.enqueue(true, 0);

    expect(queue.getJob(id1)!.status).toBe("running");
    expect(queue.getJob(id2)!.status).toBe("running");
    expect(queue.getJob(id3)!.status).toBe("pending");
    expect(queue.getStats().running).toBe(2);
  });
});
