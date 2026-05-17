import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { serializeDocUpdateRun } from "@/lib/nbrain/api-serializers";
import { parseMergedPrWebhookPayload } from "@/lib/nbrain/github";
import { runMergedPrUpdatePipeline } from "@/lib/nbrain/update-pipeline";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  if (webhookSecret && !verifyGitHubSignature(rawBody, request.headers, webhookSecret)) {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 401 });
  }

  const eventName = request.headers.get("x-github-event");

  if (eventName && eventName !== "pull_request") {
    return NextResponse.json({ ignored: true, reason: "not_pull_request_event" });
  }

  let payload: unknown;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const parsed = parseMergedPrWebhookPayload(payload);

  if (parsed.ignored) {
    return NextResponse.json({ ignored: true, reason: parsed.reason });
  }

  try {
    const updateRun = await runMergedPrUpdatePipeline({
      event: parsed.event,
    });

    return NextResponse.json({
      ignored: false,
      updateRun: serializeDocUpdateRun(updateRun),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Webhook processing failed." },
      { status: 500 },
    );
  }
}

function verifyGitHubSignature(
  rawBody: string,
  headers: Headers,
  webhookSecret: string,
): boolean {
  const header = headers.get("x-hub-signature-256");

  if (!header?.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex")}`;

  const actualBuffer = Buffer.from(header);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
