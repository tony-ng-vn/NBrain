import { NextResponse } from "next/server";
import { z } from "zod";
import { serializeImportRun } from "@/lib/nbrain/api-serializers";
import { runImportPipeline } from "@/lib/nbrain/import-pipeline";
import { createImportRun } from "@/lib/nbrain/run-store";

export const runtime = "nodejs";

const ImportRequestSchema = z.object({
  githubUrl: z.string().min(1),
  notionParentPageId: z.string().min(1).optional(),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = ImportRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid import request.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const run = createImportRun(parsed.data.githubUrl);
  const completedRun = await runImportPipeline(run.id, parsed.data);

  return NextResponse.json({
    runId: completedRun.id,
    run: serializeImportRun(completedRun),
  });
}
