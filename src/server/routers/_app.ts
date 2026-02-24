import { z } from "zod";
import { router, publicProcedure } from "../trpc";
import { getFilesStatus, runConversion } from "../services/converter";

export const appRouter = router({
  getFiles: publicProcedure.query(async () => {
    return await getFilesStatus();
  }),

  startConversion: publicProcedure
    .input(
      z.object({
        batchSize: z.number().min(1).max(20).optional().default(3),
      })
    )
    .mutation(async ({ input }) => {
      // In a real production app you'd run this asynchronously with a job queue, 
      // but here we wait for it to finish and return the summary.
      const result = await runConversion(input.batchSize);
      return result;
    }),
});

export type AppRouter = typeof appRouter;
