import { NextRequest, NextResponse } from "next/server";
import { conversionQueue } from "@/server/services/queue";

/**
 * GET /api/job/:jobId
 * Returns the current status of a conversion job.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;
  const job = conversionQueue.getJob(jobId);

  if (!job) {
    return NextResponse.json({ error: "Job not found or expired." }, { status: 404 });
  }

  switch (job.status) {
    case "pending":
      return NextResponse.json({ status: "pending", position: job.position });

    case "running":
      return NextResponse.json({ status: "running" });

    case "done":
      return NextResponse.json({
        status: "done",
        fileCount: job.outputPaths.length,
        downloadUrl: `/api/job/${jobId}/download`,
      });

    case "error":
      return NextResponse.json({ status: "error", message: job.error });

    default:
      return NextResponse.json({ status: job.status });
  }
}
