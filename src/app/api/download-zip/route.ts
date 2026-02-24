import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";

export async function GET() {
  const OUTPUT_DIR = path.resolve(process.cwd(), "ciktilar");

  if (!fs.existsSync(OUTPUT_DIR)) {
    return new NextResponse("Çıktı klasörü bulunamadı.", { status: 404 });
  }

  const files = fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => path.extname(f).toLowerCase() === ".pdf");

  if (files.length === 0) {
    return new NextResponse("İndirilecek PDF bulunamadı.", { status: 404 });
  }

  // Create ZIP archive
  const zip = new AdmZip();
  
  files.forEach((file) => {
    zip.addLocalFile(path.join(OUTPUT_DIR, file));
  });

  const zipBuffer = zip.toBuffer();

  return new NextResponse(new Uint8Array(zipBuffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="Sunum_Ciktilari.zip"',
    },
  });
}
