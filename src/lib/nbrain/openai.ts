import OpenAI from "openai";
import { fallbackClaimsFromMarkdown, materializeClaims, parseClaimExtractionResponse } from "./claims";
import { PatchProposalSchema, type DocClaim, type DocSection, type MergedPrEvent, type PatchProposal } from "./schemas";

let openai: OpenAI | undefined;

function getOpenAI(): OpenAI | undefined {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return undefined;
  }

  openai ??= new OpenAI({ apiKey });
  return openai;
}

export async function extractClaimsForSection(args: {
  sectionId: string;
  markdown: string;
}): Promise<DocClaim[]> {
  const client = getOpenAI();

  if (!client) {
    return fallbackClaimsFromMarkdown(args.sectionId, args.markdown);
  }

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Extract 1-5 durable repo documentation claims. Return JSON only: {\"claims\":[{\"text\":\"...\",\"kind\":\"api|route|config|concept|dependency|behavior|file\",\"coveredPaths\":[\"README.md\"],\"concepts\":[\"...\"],\"dependencyClaimIds\":[],\"evidenceRefs\":[\"...\"],\"confidence\":0.7}]}",
        },
        {
          role: "user",
          content: args.markdown.slice(0, 12000),
        },
      ],
    });

    const content = response.choices[0]?.message.content ?? "{\"claims\":[]}";
    const parsed = parseClaimExtractionResponse(JSON.parse(content));
    const claims = materializeClaims(args.sectionId, parsed);
    return claims.length > 0 ? claims : fallbackClaimsFromMarkdown(args.sectionId, args.markdown);
  } catch {
    return fallbackClaimsFromMarkdown(args.sectionId, args.markdown);
  }
}

export async function buildPatchProposal(args: {
  event: MergedPrEvent;
  impactedClaims: DocClaim[];
  impactedSections: DocSection[];
  weakEvidence?: boolean;
}): Promise<PatchProposal> {
  const client = getOpenAI();

  if (!client) {
    return deterministicPatchProposal(args);
  }

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Return a conservative NBrain PatchProposal JSON with max 5 operations. Prefer replace_section or mark_claim_stale. Do not remove claims. Every automatic operation needs evidenceRefs.",
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              mergedPullRequest: args.event,
              impactedClaims: args.impactedClaims,
              impactedSections: args.impactedSections.map((section) => ({
                id: section.id,
                title: section.title,
                renderedNotionHash: section.renderedNotionHash,
                markdown: section.renderedMarkdown.slice(0, 6000),
              })),
            },
            null,
            2,
          ),
        },
      ],
    });

    const content = response.choices[0]?.message.content ?? "{}";
    return PatchProposalSchema.parse(JSON.parse(content));
  } catch {
    return deterministicPatchProposal(args);
  }
}

function deterministicPatchProposal(args: {
  event: MergedPrEvent;
  impactedClaims: DocClaim[];
  impactedSections: DocSection[];
  weakEvidence?: boolean;
}): PatchProposal {
  const firstSection = args.impactedSections[0];
  const firstClaim = args.impactedClaims[0];

  if (!firstSection || !firstClaim || args.weakEvidence) {
    return {
      summary: "The merged PR needs human review before documentation can be updated.",
      operations: [
        {
          type: "create_review_task",
          sectionId: firstSection?.id,
          claimIds: args.impactedClaims.map((claim) => claim.id),
          reason: "The changed files do not provide enough direct evidence for a safe automatic update.",
          unresolvedQuestion: "Which repo guide claims should change because of this PR?",
          evidenceRefs: args.event.changedFiles,
        },
      ],
    };
  }

  return {
    summary: `Update ${firstSection.title} from merged PR #${args.event.number}.`,
    operations: [
      {
        type: "replace_section",
        sectionId: firstSection.id,
        expectedRenderedHash: firstSection.renderedNotionHash,
        markdown: [
          firstSection.renderedMarkdown.trim(),
          "",
          "## Latest Verified Change",
          "",
          `Merged PR #${args.event.number} (${args.event.title}) changed ${args.event.changedFiles.join(", ")}.`,
        ].join("\n"),
        evidenceRefs: args.event.changedFiles,
        removedClaimIds: [],
      },
    ],
  };
}
