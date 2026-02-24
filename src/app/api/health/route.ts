import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
  const isHealthy = {
    status: "ok",
    timestamp: new Date().toISOString(),
    directories: {
      girdiler: false,
      ciktilar: false,
    },
    ram_usage: process.memoryUsage().rss / 1024 / 1024 + " MB",
  };

  try {
    const defaultInputs = path.resolve(process.cwd(), "girdiler");
    const defaultOutputs = path.resolve(process.cwd(), "ciktilar");

    if (fs.existsSync(defaultInputs)) {
      isHealthy.directories.girdiler = true;
    }
    if (fs.existsSync(defaultOutputs)) {
      isHealthy.directories.ciktilar = true;
    }

    // Health is ok if process is up, even if directories are missing
    // (the main logic auto-creates them but it's good to track status)
    return NextResponse.json(isHealthy, { status: 200 });
  } catch (error: any) {
    return NextResponse.json(
      { status: "error", message: error.message },
      { status: 500 }
    );
  }
}
