import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { conversionQueue } from "@/server/services/queue";

/**
 * GET /api/job/:jobId/download
 * Streams the converted PDF (or a ZIP if multiple files) back to the client
 * then cleans up the temp directory.
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

  if (job.status !== "done") {
    return NextResponse.json(
      { error: `Job is not ready yet. Current status: ${job.status}` },
      { status: 409 }
    );
  }

  const { outputPaths } = job;

  try {
    if (outputPaths.length === 1) {
      const pdfBuffer = fs.readFileSync(outputPaths[0]);
      const fileName = path.basename(outputPaths[0]);

      // Clean up after serving
      setImmediate(() => conversionQueue.cleanup(jobId));

      return new NextResponse(new Uint8Array(pdfBuffer), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${fileName}"`,
        },
      });
    } else {
      // Multiple PDFs → ZIP
      const zip = new AdmZip();
      for (const pdfPath of outputPaths) {
        zip.addLocalFile(pdfPath);
      }
      const zipBuffer = zip.toBuffer();
      const zipName = `Sunum_Ciktilari_${jobId.substring(0, 6)}.zip`;

      // Clean up after serving
      setImmediate(() => conversionQueue.cleanup(jobId));

      return new NextResponse(new Uint8Array(zipBuffer), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${zipName}"`,
        },
      });
    }
  } catch (err: any) {
    console.error("Download error:", err);
    return NextResponse.json(
      { error: err.message ?? "Download failed." },
      { status: 500 }
    );
  }
}
