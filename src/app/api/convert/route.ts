import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { conversionQueue, JobFile } from "../../../server/services/queue";

// We no longer need a long maxDuration — we just enqueue and return immediately.
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const rawFiles = formData.getAll("file") as File[];

    if (!rawFiles || rawFiles.length === 0) {
      return NextResponse.json(
        { error: "Lütfen en az 1 dosya yükleyin." },
        { status: 400 }
      );
    }

    // Read all files into memory, validate extensions
    const jobFiles: JobFile[] = [];
    for (const file of rawFiles) {
      const ext = path.extname(file.name).toLowerCase();
      if (![".ppt", ".pptx"].includes(ext)) continue;

      const arrayBuffer = await file.arrayBuffer();
      jobFiles.push({ name: file.name, buffer: Buffer.from(arrayBuffer) });
    }

    if (jobFiles.length === 0) {
      return NextResponse.json(
        { error: "Geçerli .ppt/.pptx dosyası bulunamadı." },
        { status: 400 }
      );
    }

    // Hand off to the queue — returns a jobId immediately
    const jobId = conversionQueue.enqueue(jobFiles);

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error: any) {
    console.error("Conversion enqueue error:", error);
    return NextResponse.json(
      { error: error.message ?? "Beklenmeyen bir hata oluştu." },
      { status: 500 }
    );
  }
}
