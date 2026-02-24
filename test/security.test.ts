import { describe, it, expect } from "vitest";
import { appRouter } from "../src/server/routers/_app";

describe("Security & Cyber Attack Simulations", () => {
  const caller = appRouter.createCaller({});

  it("should block Denial of Service (DoS) attempts via enormous batchSize", async () => {
    // Zod must block massive batchSizes immediately with a TRPCError (BAD_REQUEST)
    await expect(
      caller.startConversion({ batchSize: 9999999 })
    ).rejects.toThrow();
  });

  it("should block batchSize of 0 or negative numbers", async () => {
    await expect(
      caller.startConversion({ batchSize: -5 })
    ).rejects.toThrow();
  });

  it("should use the default safe batch size if none is provided", async () => {
    // Should run successfully without throwing a Zod validation error
    // Note: since this also triggers LibreOffice locally, we just mock the logic in a real test environment,
    // but here we just ensure TRPC routing allows the input (no validation crash).
    // Using simple expect to not crash (if files are 0, it just returns { success: 0 })
    const res = await caller.startConversion({});
    expect(res).toHaveProperty("success");
    expect(res).toHaveProperty("total");
  });
});
