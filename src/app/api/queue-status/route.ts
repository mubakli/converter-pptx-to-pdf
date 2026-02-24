import { NextResponse } from "next/server";
import { conversionQueue } from "../../../server/services/queue";

/**
 * GET /api/queue-status
 * Lightweight endpoint that returns only live queue metrics.
 * Polled by the frontend every few seconds to show server load.
 */
export async function GET() {
  const stats = conversionQueue.getStats();
  return NextResponse.json(stats, {
    status: 200,
    headers: {
      // Don't cache — must always be fresh
      "Cache-Control": "no-store",
    },
  });
}
