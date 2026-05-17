import { z } from "zod";

export const ClaimKindSchema = z.enum([
  "api",
  "route",
  "config",
  "concept",
  "dependency",
  "behavior",
  "file",
]);

export const ClaimStatusSchema = z.enum(["fresh", "suspect", "stale"]);

export const RepoSourceSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  githubUrl: z.string().url(),
  defaultBranch: z.string().min(1).default("main"),
  hubPageId: z.string().optional(),
  latestImportRunId: z.string().optional(),
});

export const DocClaimSchema = z.object({
  id: z.string().min(1),
  sectionId: z.string().min(1),
  text: z.string().min(1),
  kind: ClaimKindSchema,
  coveredPaths: z.array(z.string()).default([]),
  concepts: z.array(z.string()).default([]),
  dependencyClaimIds: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  staleStatus: ClaimStatusSchema.default("fresh"),
});

export const DocSectionSchema = z.object({
  id: z.string().min(1),
  repoFullName: z.string().min(1),
  title: z.string().min(1),
  sourceMarkdown: z.string(),
  sourceMarkdownHash: z.string().min(1),
  renderedMarkdown: z.string(),
  renderedNotionHash: z.string().min(1),
  claimIds: z.array(z.string()).default([]),
  notionPageId: z.string().optional(),
  notionUrl: z.string().url().optional(),
  sourceSnapshot: z.record(z.string(), z.unknown()).default({}),
});

export const MergedPrEventSchema = z.object({
  repo: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().optional().default(""),
  baseBranch: z.string().min(1),
  merged: z.boolean().default(true),
  mergeCommitSha: z.string().optional(),
  htmlUrl: z.string().url().optional(),
  changedFiles: z.array(z.string()).default([]),
});

const EvidenceRefsSchema = z.array(z.string().min(1)).min(1);

const UpdateClaimOperationSchema = z.object({
  type: z.literal("update_claim"),
  claimId: z.string().min(1),
  text: z.string().min(1),
  evidenceRefs: EvidenceRefsSchema,
});

const AddClaimOperationSchema = z.object({
  type: z.literal("add_claim"),
  sectionId: z.string().min(1),
  claim: DocClaimSchema.omit({ id: true, sectionId: true }),
  evidenceRefs: EvidenceRefsSchema,
});

const MarkClaimStaleOperationSchema = z.object({
  type: z.literal("mark_claim_stale"),
  claimId: z.string().min(1),
  staleStatus: z.enum(["suspect", "stale"]),
  evidenceRefs: EvidenceRefsSchema,
});

const ReplaceSectionOperationSchema = z.object({
  type: z.literal("replace_section"),
  sectionId: z.string().min(1),
  expectedRenderedHash: z.string().min(1),
  markdown: z.string().min(1),
  evidenceRefs: EvidenceRefsSchema,
  removedClaimIds: z.array(z.string()).default([]),
});

const CreateReviewTaskOperationSchema = z.object({
  type: z.literal("create_review_task"),
  sectionId: z.string().optional(),
  claimIds: z.array(z.string()).default([]),
  reason: z.string().min(1),
  unresolvedQuestion: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
});

const SkipOperationSchema = z.object({
  type: z.literal("skip"),
  reason: z.string().min(1),
});

export const PatchOperationSchema = z.discriminatedUnion("type", [
  UpdateClaimOperationSchema,
  AddClaimOperationSchema,
  MarkClaimStaleOperationSchema,
  ReplaceSectionOperationSchema,
  CreateReviewTaskOperationSchema,
  SkipOperationSchema,
]);

export const PatchProposalSchema = z.object({
  summary: z.string().min(1),
  operations: z.array(PatchOperationSchema).max(5),
});

export const ClaimExtractionClaimSchema = z.object({
  text: z.string().min(1),
  kind: ClaimKindSchema.default("concept"),
  coveredPaths: z.array(z.string()).default([]),
  concepts: z.array(z.string()).default([]),
  dependencyClaimIds: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});

export const ClaimExtractionResponseSchema = z.object({
  claims: z.array(ClaimExtractionClaimSchema).max(5),
});

export type RepoSource = z.infer<typeof RepoSourceSchema>;
export type DocClaim = z.infer<typeof DocClaimSchema>;
export type DocSection = z.infer<typeof DocSectionSchema>;
export type MergedPrEvent = z.infer<typeof MergedPrEventSchema>;
export type PatchProposal = z.infer<typeof PatchProposalSchema>;
export type PatchOperation = z.infer<typeof PatchOperationSchema>;
export type ClaimExtractionResponse = z.infer<typeof ClaimExtractionResponseSchema>;
