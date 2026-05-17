import { NextResponse } from "next/server";
import { serializeDocUpdateRun, serializeImportRun } from "@/lib/nbrain/api-serializers";
import { getImportRun, listDocUpdateRuns } from "@/lib/nbrain/run-store";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  const run = getImportRun(runId);

  if (!run) {
    return NextResponse.json({ error: "Import run not found." }, { status: 404 });
  }

  return NextResponse.json({
    run: serializeImportRun(run),
    updateRuns: listDocUpdateRuns()
      .filter((updateRun) => updateRun.importRunId === run.id)
      .map(serializeDocUpdateRun),
  });
}
