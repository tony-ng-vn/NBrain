import { describe, expect, it } from "vitest";
import { fallbackClaimsFromMarkdown, parseClaimExtractionResponse } from "@/lib/nbrain/claims";
import { parseGitHubRepoUrl, parseMergedPrWebhookPayload } from "@/lib/nbrain/github";
import { stableHash } from "@/lib/nbrain/hash";
import { rankClaimsForPr } from "@/lib/nbrain/matcher";
import type { NotionPort } from "@/lib/nbrain/notion";
import { createImportRun, updateImportRun } from "@/lib/nbrain/run-store";
import { runMergedPrUpdatePipeline } from "@/lib/nbrain/update-pipeline";
import { verifyPatchProposal } from "@/lib/nbrain/verifier";
import type { DocClaim, DocSection, MergedPrEvent } from "@/lib/nbrain/schemas";
import safeFixture from "@/fixtures/safe-merged-pr.json";
import reviewFixture from "@/fixtures/review-merged-pr.json";

describe("parseGitHubRepoUrl", () => {
  it("accepts public GitHub repository URLs", () => {
    expect(parseGitHubRepoUrl("https://github.com/openai/openai-node")).toMatchObject({
      owner: "openai",
      repo: "openai-node",
      fullName: "openai/openai-node",
      githubUrl: "https://github.com/openai/openai-node",
    });

    expect(parseGitHubRepoUrl("https://github.com/vercel/next.js.git")).toMatchObject({
      owner: "vercel",
      repo: "next.js",
    });
  });

  it("rejects non-GitHub and invalid URLs", () => {
    expect(() => parseGitHubRepoUrl("https://gitlab.com/acme/repo")).toThrow(
      /github.com/,
    );
    expect(() => parseGitHubRepoUrl("not a url")).toThrow(/valid GitHub/);
    expect(() => parseGitHubRepoUrl("https://github.com/acme")).toThrow(
      /owner\/repo/,
    );
  });
});

describe("claim extraction parser", () => {
  it("validates OpenAI JSON against the claim schema", () => {
    const parsed = parseClaimExtractionResponse({
      claims: [
        {
          text: "The API route imports repo knowledge into Notion.",
          kind: "route",
          coveredPaths: ["src/app/api/import/route.ts"],
          concepts: ["import", "notion"],
          evidenceRefs: ["src/app/api/import/route.ts"],
          confidence: 0.8,
        },
      ],
    });

    expect(parsed.claims[0]?.kind).toBe("route");
    expect(parsed.claims[0]?.coveredPaths).toEqual(["src/app/api/import/route.ts"]);
  });

  it("rejects invalid model JSON", () => {
    expect(() =>
      parseClaimExtractionResponse({
        claims: [{ text: "", kind: "made-up-kind" }],
      }),
    ).toThrow();
  });
});

describe("fallback claim extraction", () => {
  it("uses referenced source paths as claim evidence", () => {
    const [claim] = fallbackClaimsFromMarkdown(
      "section-code-map",
      [
        "# Codebase Map",
        "",
        "## Primary source paths",
        "",
        "- src/app/api/chat/route.ts",
        "- convex/schema.ts",
      ].join("\n"),
    );

    expect(claim?.coveredPaths).toEqual(["src/app/api/chat/route.ts", "convex/schema.ts"]);
    expect(claim?.evidenceRefs).toEqual(["src/app/api/chat/route.ts", "convex/schema.ts"]);
  });
});

describe("claim matcher", () => {
  it("ranks direct path matches above concept-only matches", () => {
    const directClaim = claim({
      id: "direct",
      coveredPaths: ["src/app/api/import/route.ts"],
      concepts: ["import"],
    });
    const conceptClaim = claim({
      id: "concept",
      coveredPaths: [],
      concepts: ["import"],
    });
    const event: MergedPrEvent = {
      repo: { owner: "acme", repo: "demo" },
      number: 12,
      title: "Improve import pipeline",
      body: "",
      baseBranch: "main",
      merged: true,
      changedFiles: ["src/app/api/import/route.ts"],
    };

    const matches = rankClaimsForPr(event, [conceptClaim, directClaim]);

    expect(matches.map((match) => match.claim.id)).toEqual(["direct", "concept"]);
    expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score ?? 0);
  });
});

describe("verifier", () => {
  it("accepts a scoped update with evidence", () => {
    const section = sectionFixture();
    const matchedClaim = claim({ id: "claim-1", sectionId: section.id });
    const result = verifyPatchProposal(
      {
        summary: "Update route wording.",
        operations: [
          {
            type: "update_claim",
            claimId: matchedClaim.id,
            text: "The import route writes repo claims into Notion.",
            evidenceRefs: ["src/app/api/import/route.ts"],
          },
        ],
      },
      {
        claimsById: { [matchedClaim.id]: matchedClaim },
        sectionsById: { [section.id]: section },
        impactedClaimIds: [matchedClaim.id],
        changedFiles: ["src/app/api/import/route.ts"],
      },
    );

    expect(result.accepted).toBe(true);
  });

  it("rejects removal without hard evidence", () => {
    const section = sectionFixture();
    const matchedClaim = claim({ id: "claim-1", sectionId: section.id });
    const result = verifyPatchProposal(
      {
        summary: "Replace the section and remove a claim.",
        operations: [
          {
            type: "replace_section",
            sectionId: section.id,
            expectedRenderedHash: section.renderedNotionHash,
            markdown: "# Repo Guide\nUpdated.",
            evidenceRefs: ["src/app/api/import/route.ts"],
            removedClaimIds: [matchedClaim.id],
          },
        ],
      },
      {
        claimsById: { [matchedClaim.id]: matchedClaim },
        sectionsById: { [section.id]: section },
        impactedClaimIds: [matchedClaim.id],
        changedFiles: ["src/app/api/import/route.ts"],
      },
    );

    expect(result).toMatchObject({
      accepted: false,
      reasons: ["auto_remove_not_allowed"],
    });
  });

  it("creates a review path when the Notion section hash changed", () => {
    const section = sectionFixture();
    const matchedClaim = claim({ id: "claim-1", sectionId: section.id });
    const result = verifyPatchProposal(
      {
        summary: "Replace section.",
        operations: [
          {
            type: "replace_section",
            sectionId: section.id,
            expectedRenderedHash: section.renderedNotionHash,
            markdown: "# Repo Guide\nUpdated.",
            evidenceRefs: ["src/app/api/import/route.ts"],
          },
        ],
      },
      {
        claimsById: { [matchedClaim.id]: matchedClaim },
        sectionsById: { [section.id]: section },
        impactedClaimIds: [matchedClaim.id],
        changedFiles: ["src/app/api/import/route.ts"],
        currentRenderedHashes: {
          [section.id]: "user-edited-hash",
        },
      },
    );

    expect(result).toMatchObject({
      accepted: false,
      requiresReview: true,
      reasons: ["target_user_edited_content"],
    });
  });
});

describe("webhook payload filtering", () => {
  it("ignores non-merged PRs and PRs not targeting main", () => {
    expect(
      parseMergedPrWebhookPayload(webhookPayload({ merged: false, baseRef: "main" })),
    ).toMatchObject({
      ignored: true,
      reason: "pull_request_not_merged",
    });

    expect(
      parseMergedPrWebhookPayload(webhookPayload({ merged: true, baseRef: "develop" })),
    ).toMatchObject({
      ignored: true,
      reason: "base_branch_not_main",
    });
  });

  it("returns a merged PR event for closed merged PRs targeting main", () => {
    expect(
      parseMergedPrWebhookPayload(webhookPayload({ merged: true, baseRef: "main" })),
    ).toMatchObject({
      ignored: false,
      event: {
        number: 42,
        baseBranch: "main",
        repo: { owner: "acme", repo: "demo" },
      },
    });
  });
});

describe("replay fixtures", () => {
  it("produces a Doc Update Run with one safe section update", async () => {
    const importRun = seedCompletedImportRun();
    const fakeNotion = createFakeNotion();
    const parsed = parseMergedPrWebhookPayload(safeFixture);

    if (parsed.ignored) {
      throw new Error(parsed.reason);
    }

    const result = await runMergedPrUpdatePipeline(
      {
        importRunId: importRun.id,
        event: parsed.event,
      },
      {
        notion: fakeNotion,
        fetchChangedFiles: async () => safeFixture.nbrain_changed_files,
      },
    );

    expect(result.status).toBe("completed");
    expect(result.appliedSectionIds).toHaveLength(1);
    expect(result.reviewTasks).toHaveLength(0);
  });

  it("produces a Doc Update Run with a review task when evidence is weak", async () => {
    const importRun = seedCompletedImportRun();
    const fakeNotion = createFakeNotion();
    const parsed = parseMergedPrWebhookPayload(reviewFixture);

    if (parsed.ignored) {
      throw new Error(parsed.reason);
    }

    const result = await runMergedPrUpdatePipeline(
      {
        importRunId: importRun.id,
        event: parsed.event,
        weakEvidence: true,
      },
      {
        notion: fakeNotion,
        fetchChangedFiles: async () => reviewFixture.nbrain_changed_files,
      },
    );

    expect(result.status).toBe("completed");
    expect(result.appliedSectionIds).toHaveLength(0);
    expect(result.reviewTasks).toHaveLength(1);
  });
});

function sectionFixture(overrides: Partial<DocSection> = {}): DocSection {
  return {
    id: "section-1",
    repoFullName: "acme/demo",
    title: "Repo Guide",
    sourceMarkdown: "# Repo Guide\nOriginal.",
    sourceMarkdownHash: "source-hash",
    renderedMarkdown: "# Repo Guide\nOriginal.",
    renderedNotionHash: "rendered-hash",
    claimIds: ["claim-1"],
    sourceSnapshot: {},
    ...overrides,
  };
}

function claim(overrides: Partial<DocClaim> = {}): DocClaim {
  return {
    id: "claim-1",
    sectionId: "section-1",
    text: "The import route writes repo guide data.",
    kind: "route",
    coveredPaths: ["src/app/api/import/route.ts"],
    concepts: ["import"],
    dependencyClaimIds: [],
    evidenceRefs: ["src/app/api/import/route.ts"],
    confidence: 0.8,
    staleStatus: "fresh",
    ...overrides,
  };
}

function webhookPayload({
  merged,
  baseRef,
}: {
  merged: boolean;
  baseRef: string;
}) {
  return {
    action: "closed",
    repository: {
      name: "demo",
      owner: {
        login: "acme",
      },
    },
    pull_request: {
      number: 42,
      title: "Ship change",
      body: "Updates docs",
      merged,
      html_url: "https://github.com/acme/demo/pull/42",
      merge_commit_sha: "abc123",
      base: {
        ref: baseRef,
      },
    },
  };
}

function seedCompletedImportRun() {
  const run = createImportRun("https://github.com/acme/demo");
  const section = sectionFixture({
    notionPageId: "notion-section-1",
    notionUrl: "https://notion.so/section-1",
  });
  const seededClaim = claim({
    id: "claim-1",
    sectionId: section.id,
    coveredPaths: ["README.md"],
    concepts: ["setup", "readme"],
    evidenceRefs: ["README.md"],
  });

  return updateImportRun(run.id, {
    status: "completed",
    repo: {
      owner: "acme",
      repo: "demo",
      githubUrl: "https://github.com/acme/demo",
      defaultBranch: "main",
      hubPageId: "notion-hub",
      latestImportRunId: run.id,
    },
    hubPageId: "notion-hub",
    hubUrl: "https://notion.so/hub",
    databases: {
      docSections: "db-sections",
      docClaims: "db-claims",
      mergedPrs: "db-prs",
      docUpdateRuns: "db-runs",
      reviewQueue: "db-review",
    },
    sections: [{ ...section, claimIds: [seededClaim.id] }],
    claims: [seededClaim],
  });
}

function createFakeNotion(): NotionPort {
  return {
    async createWorkspace() {
      throw new Error("not used");
    },
    async createSectionPage() {
      throw new Error("not used");
    },
    async persistSectionsAndClaims() {
      throw new Error("not used");
    },
    async recordMergedPr() {
      return undefined;
    },
    async recordDocUpdateRun() {
      return undefined;
    },
    async createReviewTask({ task }) {
      return {
        id: "review-task",
        title: task.title,
        reason: task.reason,
        unresolvedQuestion: task.unresolvedQuestion,
        prUrl: task.prUrl,
        changedFiles: task.changedFiles,
        affectedClaimIds: task.affectedClaimIds,
        evidenceRefs: task.evidenceRefs,
        notionPageUrl: "https://notion.so/review-task",
      };
    },
    async getRenderedHash(section) {
      return section.renderedNotionHash;
    },
    async replaceSectionContent(_section, markdown) {
      return stableHash(markdown);
    },
  };
}
