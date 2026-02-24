import { describe, it, expect, vi } from "vitest";

// A mock to simulate Next.js Request and Response logic
import { GET } from "../src/app/api/health/route";

describe("Health Check API", () => {
  it("should return status 200 and report directories", async () => {
    // Next.js Route Handlers return a Web Response object
    const res = await GET() as Response;
    
    expect(res.status).toBe(200);
    
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("directories");
    expect(body).toHaveProperty("ram_usage");
  });
});
