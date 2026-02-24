import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import os from "os";
import AdmZip from "adm-zip";
import { convertFileDirect } from "../../../server/services/converter";
import { ensureDir } from "../../../server/services/converter"; // Helper function

// Vercel limit or custom chunking
export const maxDuration = 120; // 2 minutes max for long conversions, if supported by deployment.

export async function POST(req: NextRequest) {
  const sessionId = uuidv4();
  const tempDir = path.join(os.tmpdir(), `pptx-converter-${sessionId}`);
  
  try {
    const formData = await req.formData();
    const files = formData.getAll("file") as File[];
    
    if (!files || files.length === 0) {
      return NextResponse.json({ error: "Lütfen en az 1 dosya yükleyin (min 1 file req)." }, { status: 400 });
    }

    // 1. Create unique job folder
    ensureDir(tempDir);

    const convertedPaths: string[] = [];

    // 2. Process all uploaded files
    for (const file of files) {
      // Validate PPTX / PPT
      const ext = path.extname(file.name).toLowerCase();
      if (![".ppt", ".pptx"].includes(ext)) {
        continue;
      }

      // Read boundary stream into ArrayBuffer then Buffer
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Save to OS temp folder
      const inputPath = path.join(tempDir, file.name);
      fs.writeFileSync(inputPath, buffer);

      // Setup output path (.pdf)
      const baseName = path.basename(file.name, ext);
      const outputPath = path.join(tempDir, `${baseName}.pdf`);

      // 3. Convert via our existing LibreOffice wrapper
      const success = await convertFileDirect(inputPath, outputPath);
      if (success) {
        convertedPaths.push(outputPath);
      }
    }

    if (convertedPaths.length === 0) {
      throw new Error("Hiçbir dosya başarıyla dönüştürülemedi (All conversions failed).");
    }

    // 4. Return Output (Single PDF or ZIP if multiple)
    if (convertedPaths.length === 1) {
      const pdfBuffer = fs.readFileSync(convertedPaths[0]);
      const pdfName = path.basename(convertedPaths[0]);
      
      // Response with the single PDF
      return new NextResponse(new Uint8Array(pdfBuffer), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${pdfName}"`
        }
      });
    } else {
      // Multiple files => Zip them
      const zip = new AdmZip();
      for (const pdfPath of convertedPaths) {
         zip.addLocalFile(pdfPath);
      }
      
      const zipBuffer = zip.toBuffer();
      return new NextResponse(new Uint8Array(zipBuffer), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="Sunum_Ciktilari_${sessionId.substring(0,6)}.zip"`
        }
      });
    }
  } catch (error: any) {
    console.error("Conversion API Error:", error);
    return NextResponse.json({ error: error.message || "Dönüştürme çöktü (Conversion crash)." }, { status: 500 });
  } finally {
    // 5. Cleanup memory and isolated disk space
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        console.error("Silme hatası (Cleanup fail):", err);
      }
    }
  }
}
