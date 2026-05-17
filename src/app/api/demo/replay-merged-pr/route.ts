import { NextResponse } from "next/server";
import { z } from "zod";
import reviewFixture from "@/fixtures/review-merged-pr.json";
import safeFixture from "@/fixtures/safe-merged-pr.json";
import { serializeDocUpdateRun } from "@/lib/nbrain/api-serializers";
import { parseMergedPrWebhookPayload } from "@/lib/nbrain/github";
import { runMergedPrUpdatePipeline } from "@/lib/nbrain/update-pipeline";

export const runtime = "nodejs";

const ReplayRequestSchema = z.object({
  importRunId: z.string().min(1).optional(),
  fixture: z.enum(["safe-update", "review-task"]).default("safe-update"),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = ReplayRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid replay request.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const fixture = parsed.data.fixture === "review-task" ? reviewFixture : safeFixture;
  const webhook = parseMergedPrWebhookPayload(fixture);

  if (webhook.ignored) {
    return NextResponse.json({ error: webhook.reason }, { status: 400 });
  }

  try {
    const updateRun = await runMergedPrUpdatePipeline(
      {
        importRunId: parsed.data.importRunId,
        event: {
          ...webhook.event,
          changedFiles: fixture.nbrain_changed_files,
        },
        weakEvidence: fixture.nbrain_fixture === "review-task",
      },
      {
        fetchChangedFiles: async () => fixture.nbrain_changed_files,
      },
    );

    return NextResponse.json({
      updateRun: serializeDocUpdateRun(updateRun),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Replay failed." },
      { status: 500 },
    );
  }
}
