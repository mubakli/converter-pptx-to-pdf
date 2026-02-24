import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { conversionQueue } from "../../../server/services/queue";

export async function GET() {
  const result = {
    status: "ok",
    timestamp: new Date().toISOString(),
    directories: {
      girdiler: false,
      ciktilar: false,
    },
    ram_usage: `${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`,
    queue: conversionQueue.getStats(),
  };

  try {
    const defaultInputs = path.resolve(process.cwd(), "girdiler");
    const defaultOutputs = path.resolve(process.cwd(), "ciktilar");

    if (fs.existsSync(defaultInputs)) result.directories.girdiler = true;
    if (fs.existsSync(defaultOutputs)) result.directories.ciktilar = true;

    return NextResponse.json(result, { status: 200 });
  } catch (error: any) {
    return NextResponse.json(
      { status: "error", message: error.message },
      { status: 500 }
    );
  }
}
