import crypto from "node:crypto";
import { Worker, WebhookVerificationError } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import type { CapabilityContext } from "@notionhq/workers";

const worker = new Worker();
export default worker;

type NotionClient = CapabilityContext["notion"];

type MergedPrEvent = {
	owner: string;
	repo: string;
	number: number;
	title: string;
	body: string;
	baseBranch: string;
	merged: boolean;
	mergeCommitSha: string;
	htmlUrl: string;
	changedFiles: string[];
};

type DocClaim = {
	id: string;
	pageId: string;
	sectionId: string;
	text: string;
	kind: string;
	status: string;
	coveredPaths: string[];
	concepts: string[];
	evidenceRefs: string[];
	confidence: number | null;
};

type DocSection = {
	id: string;
	pageId: string;
	title: string;
	notionPageUrl: string;
	sourceMarkdownHash: string;
	renderedNotionHash: string;
	claimIds: string[];
	status: string;
};

type ClaimMatch = {
	claim: DocClaim;
	score: number;
	reasons: string[];
};

type MergedPrRow = {
	pageId: string;
	name: string;
	prNumber: number;
	prUrl: string;
	baseBranch: string;
	mergeCommit: string;
	changedFiles: string;
	status: string;
	impactedClaimIds: string;
	impactedSectionIds: string;
	agentSummary: string;
	error: string;
};

type PatchProposal = {
	summary?: string;
	operations: PatchOperation[];
};

type PatchOperation =
	| {
			type: "update_claim";
			claimId: string;
			text: string;
			evidenceRefs: string[];
	  }
	| {
			type: "add_claim";
			sectionId: string;
			claim: {
				text: string;
				kind?: string;
				coveredPaths?: string[];
				concepts?: string[];
				evidenceRefs?: string[];
				confidence?: number;
			};
			evidenceRefs: string[];
	  }
	| {
			type: "mark_claim_stale";
			claimId: string;
			staleStatus: "suspect" | "stale";
			evidenceRefs: string[];
	  }
	| {
			type: "replace_section";
			sectionId: string;
			expectedRenderedHash: string;
			markdown: string;
			evidenceRefs: string[];
			removedClaimIds?: string[];
	  }
	| {
			type: "create_review_task";
			sectionId?: string;
			claimIds?: string[];
			reason: string;
			unresolvedQuestion: string;
			evidenceRefs?: string[];
	  }
	| {
			type: "skip";
			reason: string;
	  };

type ReviewTaskInput = {
	title: string;
	reason: string;
	unresolvedQuestion: string;
	prUrl?: string;
	changedFiles?: string[];
	affectedClaimIds?: string[];
	evidenceRefs?: string[];
	suggestedNextStep?: string;
};

const DATABASES = {
	mergedPrs: "NBRAIN_MERGED_PRS_DATABASE_ID",
	reviewQueue: "NBRAIN_REVIEW_QUEUE_DATABASE_ID",
	docSections: "NBRAIN_DOC_SECTIONS_DATABASE_ID",
	docClaims: "NBRAIN_DOC_CLAIMS_DATABASE_ID",
	docUpdateRuns: "NBRAIN_DOC_UPDATE_RUNS_DATABASE_ID",
} as const;

worker.webhook("githubPullRequestWebhook", {
	title: "GitHub Pull Request Webhook",
	description:
		"Receives GitHub pull_request.closed events, verifies signatures, stores merged PR context, and wakes the NBrain Custom Agent.",
	execute: async (events, { notion }) => {
		for (const event of events) {
			verifyGitHubSignature(event.rawBody, event.headers);

			const githubEvent = event.headers["x-github-event"];
			if (githubEvent && githubEvent !== "pull_request") {
				console.log(`Ignoring GitHub event ${githubEvent}`);
				continue;
			}

			const parsed = parsePullRequestPayload(event.body);
			if (!parsed) {
				console.log("Ignoring unsupported pull request payload");
				continue;
			}

			if (!parsed.merged || parsed.baseBranch !== "main") {
				console.log(
					`Ignoring PR #${parsed.number}: merged=${parsed.merged}, base=${parsed.baseBranch}`,
				);
				continue;
			}

			const prPageId = await upsertMergedPr(notion, parsed, "Processing", []);

			try {
				const changedFiles = await fetchPullRequestFiles(parsed);
				const eventWithFiles = { ...parsed, changedFiles };
				const claims = await listDocClaims(notion);
				const matches = rankClaimsForChangedFiles(eventWithFiles, claims).slice(0, 8);
				const impactedClaimIds = matches.map((match) => match.claim.id);
				const impactedSectionIds = unique(
					matches.map((match) => match.claim.sectionId).filter(Boolean),
				);

				await updateMergedPrPage(notion, prPageId, {
					changedFiles,
					status: "Ready for Agent",
					impactedClaimIds,
					impactedSectionIds,
					agentSummary:
						matches.length > 0
							? `Ready for agent. Matched ${matches.length} impacted claim(s).`
							: "Ready for agent. No matching claims found; likely needs review.",
				});

				console.log(`Merged PR #${parsed.number} is ready for agent review`);
			} catch (error) {
				await updateMergedPrPage(notion, prPageId, {
					status: "Error",
					error: errorMessage(error),
				});
				throw error;
			}
		}
	},
});

worker.tool("get_pr_context", {
	title: "Get PR Context",
	description:
		"Read a merged PR row from Notion, including changed files, impacted claims, impacted sections, and status.",
	hints: { readOnlyHint: true },
	schema: j.object({
		prNumber: j.integer().describe("GitHub pull request number").nullable(),
		prUrl: j.string().describe("GitHub pull request URL").nullable(),
	}),
	execute: async ({ prNumber, prUrl }, { notion }) => {
		const page = await findMergedPrPage(notion, { prNumber, prUrl });
		if (!page) {
			return json({ found: false, reason: "merged_pr_not_found" });
		}
		return json({ found: true, pr: mergedPrFromPage(page) });
	},
});

worker.tool("find_impacted_claims", {
	title: "Find Impacted Claims",
	description:
		"Rank Doc Claims by changed-file and concept matches for a merged PR or explicit changed files.",
	hints: { readOnlyHint: true },
	schema: j.object({
		prNumber: j.integer().describe("GitHub pull request number").nullable(),
		changedFiles: j.array(j.string()).describe("Changed file paths").nullable(),
	}),
	execute: async ({ prNumber, changedFiles }, { notion }) => {
		const files = changedFiles ?? (await changedFilesForPr(notion, prNumber));
		const claims = await listDocClaims(notion);
		const event = {
			title: "",
			body: "",
			changedFiles: files,
		};
		const matches = rankClaimsForChangedFiles(event, claims).slice(0, 12);
		return json({
			changedFiles: files,
			matches: matches.map((match) => ({
				claimId: match.claim.id,
				sectionId: match.claim.sectionId,
				text: match.claim.text,
				score: match.score,
				reasons: match.reasons,
			})),
		});
	},
});

worker.tool("get_managed_section", {
	title: "Get Managed Section",
	description:
		"Read one managed Repo Guide section by Section ID, including stored hashes and Notion page URL.",
	hints: { readOnlyHint: true },
	schema: j.object({
		sectionId: j.string().describe("Repo Guide section ID"),
	}),
	execute: async ({ sectionId }, { notion }) => {
		const section = await findSectionById(notion, sectionId);
		if (!section) {
			return json({ found: false, reason: "section_not_found" });
		}
		return json({ found: true, section });
	},
});

worker.tool("get_repo_context_bundle", {
	title: "Get Repo Context Bundle",
	description:
		"Return bounded PR context, impacted claims, and impacted sections for the Custom Agent.",
	hints: { readOnlyHint: true },
	schema: j.object({
		prNumber: j.integer().describe("GitHub pull request number"),
	}),
	execute: async ({ prNumber }, { notion }) => {
		const page = await findMergedPrPage(notion, { prNumber, prUrl: null });
		if (!page) {
			return json({ found: false, reason: "merged_pr_not_found" });
		}

		const pr = mergedPrFromPage(page);
		const changedFiles = splitMultiValue(pr.changedFiles);
		const claims = await listDocClaims(notion);
		const matches = rankClaimsForChangedFiles(
			{ title: pr.name, body: "", changedFiles },
			claims,
		).slice(0, 8);
		const sections = await sectionsForClaims(notion, matches.map((match) => match.claim));

		return json({
			found: true,
			pr,
			impactedClaims: matches.map((match) => ({
				claim: match.claim,
				score: match.score,
				reasons: match.reasons,
			})),
			impactedSections: sections,
		});
	},
});

worker.tool("propose_doc_patch", {
	title: "Propose Doc Patch",
	description:
		"Submit a structured NBrain patch proposal. The Worker verifies and applies safe changes or creates a review task.",
	schema: j.object({
		prNumber: j.integer().describe("GitHub pull request number").nullable(),
		patchJson: j.string().describe("JSON PatchProposal with an operations array"),
	}),
	execute: async ({ prNumber, patchJson }, { notion }) => {
		const proposal = parsePatchProposal(patchJson);
		const prPage = prNumber
			? await findMergedPrPage(notion, { prNumber, prUrl: null })
			: null;
		const pr = prPage ? mergedPrFromPage(prPage) : null;
		const changedFiles = pr ? splitMultiValue(pr.changedFiles) : [];
		const claims = await listDocClaims(notion);
		const matches = rankClaimsForChangedFiles({ title: "", body: "", changedFiles }, claims).slice(
			0,
			8,
		);
		const impactedClaimIds = new Set(matches.map((match) => match.claim.id));
		const impactedSectionIds = new Set(
			matches.map((match) => match.claim.sectionId).filter(Boolean),
		);
		const verification = await verifyPatchProposal(notion, proposal, {
			impactedClaimIds,
			impactedSectionIds,
		});

		if (!verification.accepted) {
			const task = await createReviewTask(notion, {
				title: prNumber ? `Review PR #${prNumber}` : "Review proposed doc patch",
				reason: verification.reasons.join(", "),
				unresolvedQuestion: "Can this documentation patch be safely applied?",
				prUrl: pr?.prUrl,
				changedFiles,
				affectedClaimIds: [...impactedClaimIds],
				evidenceRefs: changedFiles,
				suggestedNextStep: "Inspect the PR and update the Repo Guide manually if needed.",
			});
			await recordDocUpdateRun(notion, {
				prNumber,
				status: "Review Needed",
				proposedOperations: patchJson,
				appliedSectionIds: [],
				reviewTaskIds: [task.id],
				logs: verification.reasons,
			});
			return json({
				accepted: false,
				reviewTask: task,
				reasons: verification.reasons,
			});
		}

		const appliedSectionIds: string[] = [];
		const reviewTaskIds: string[] = [];

		for (const operation of proposal.operations) {
			if (operation.type === "replace_section") {
				const section = await findSectionById(notion, operation.sectionId);
				if (!section?.notionPageUrl) {
					const task = await createReviewTask(notion, {
						title: `Review section ${operation.sectionId}`,
						reason: "The section has no Notion Page URL for safe replacement.",
						unresolvedQuestion: "Which Notion page should NBrain update?",
						prUrl: pr?.prUrl,
						changedFiles,
						affectedClaimIds: [...impactedClaimIds],
						evidenceRefs: operation.evidenceRefs,
					});
					reviewTaskIds.push(task.id);
					continue;
				}
				await replaceSectionPage(notion, section, operation.markdown);
				appliedSectionIds.push(operation.sectionId);
			}

			if (operation.type === "update_claim") {
				await updateClaimText(notion, operation.claimId, operation.text, operation.evidenceRefs);
			}

			if (operation.type === "mark_claim_stale") {
				await markClaimStale(
					notion,
					operation.claimId,
					operation.staleStatus,
					operation.evidenceRefs,
				);
			}

			if (operation.type === "add_claim") {
				await addClaim(notion, operation.sectionId, operation.claim, operation.evidenceRefs);
			}

			if (operation.type === "create_review_task") {
				const task = await createReviewTask(notion, {
					title: prNumber ? `Review PR #${prNumber}` : "Review doc change",
					reason: operation.reason,
					unresolvedQuestion: operation.unresolvedQuestion,
					prUrl: pr?.prUrl,
					changedFiles,
					affectedClaimIds: operation.claimIds ?? [...impactedClaimIds],
					evidenceRefs: operation.evidenceRefs ?? changedFiles,
				});
				reviewTaskIds.push(task.id);
			}
		}

		const status = reviewTaskIds.length > 0 ? "Review Needed" : "Applied";
		await recordDocUpdateRun(notion, {
			prNumber,
			status,
			proposedOperations: patchJson,
			appliedSectionIds,
			reviewTaskIds,
			logs: [`Accepted patch with ${proposal.operations.length} operation(s).`],
		});

		if (prPage) {
				await updateMergedPrPage(notion, asString(prPage.id), {
					status,
					agentSummary:
						status === "Applied"
						? `Applied ${appliedSectionIds.length} section update(s).`
						: `Created ${reviewTaskIds.length} review task(s).`,
			});
		}

		return json({
			accepted: true,
			status,
			appliedSectionIds,
			reviewTaskIds,
		});
	},
});

worker.tool("create_review_task", {
	title: "Create Review Task",
	description:
		"Create a Review Queue task when evidence is weak, docs are user-edited, or a patch is unsafe.",
	schema: j.object({
		title: j.string().describe("Review task title"),
		reason: j.string().describe("Why review is needed"),
		unresolvedQuestion: j.string().describe("Question the human should answer"),
		prUrl: j.string().describe("GitHub PR URL").nullable(),
		changedFiles: j.array(j.string()).describe("Changed files").nullable(),
		affectedClaimIds: j.array(j.string()).describe("Affected claim IDs").nullable(),
		evidenceRefs: j.array(j.string()).describe("Evidence references").nullable(),
		suggestedNextStep: j.string().describe("Suggested next step").nullable(),
	}),
	execute: async (input, { notion }) => {
		return json(await createReviewTask(notion, {
			title: input.title,
			reason: input.reason,
			unresolvedQuestion: input.unresolvedQuestion,
			prUrl: input.prUrl ?? undefined,
			changedFiles: input.changedFiles ?? [],
			affectedClaimIds: input.affectedClaimIds ?? [],
			evidenceRefs: input.evidenceRefs ?? [],
			suggestedNextStep: input.suggestedNextStep ?? undefined,
		}));
	},
});

function verifyGitHubSignature(
	rawBody: string,
	headers: Record<string, string>,
): void {
	const secret = process.env.GITHUB_WEBHOOK_SECRET;
	if (!secret) {
		throw new WebhookVerificationError("GITHUB_WEBHOOK_SECRET is not configured");
	}

	const signature = headers["x-hub-signature-256"];
	if (!signature?.startsWith("sha256=")) {
		throw new WebhookVerificationError("Invalid GitHub signature");
	}

	const expected = `sha256=${crypto
		.createHmac("sha256", secret)
		.update(rawBody)
		.digest("hex")}`;

	if (
		signature.length !== expected.length ||
		!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
	) {
		throw new WebhookVerificationError("Invalid GitHub signature");
	}
}

function parsePullRequestPayload(payload: Record<string, unknown>): MergedPrEvent | null {
	const action = payload.action;
	const repository = asRecord(payload.repository);
	const owner = asRecord(repository?.owner);
	const pullRequest = asRecord(payload.pull_request);
	const base = asRecord(pullRequest?.base);

	if (action !== "closed" || !repository || !owner || !pullRequest || !base) {
		return null;
	}

	return {
		owner: asString(owner.login),
		repo: asString(repository.name),
		number: asNumber(pullRequest.number),
		title: asString(pullRequest.title),
		body: asString(pullRequest.body),
		baseBranch: asString(base.ref),
		merged: Boolean(pullRequest.merged),
		mergeCommitSha: asString(pullRequest.merge_commit_sha),
		htmlUrl: asString(pullRequest.html_url),
		changedFiles: [],
	};
}

async function fetchPullRequestFiles(event: MergedPrEvent): Promise<string[]> {
	const token = process.env.GITHUB_TOKEN;
	const files: string[] = [];

	for (let page = 1; page <= 10; page += 1) {
		const response = await fetch(
			`https://api.github.com/repos/${event.owner}/${event.repo}/pulls/${event.number}/files?per_page=100&page=${page}`,
			{
				headers: {
					accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					...(token ? { authorization: `Bearer ${token}` } : {}),
				},
			},
		);

		if (!response.ok) {
			throw new Error(`GitHub files request failed with ${response.status}`);
		}

		const pageFiles = (await response.json()) as Array<{ filename?: string }>;
		files.push(...pageFiles.map((file) => file.filename).filter(isNonEmptyString));

		if (pageFiles.length < 100) {
			break;
		}
	}

	return unique(files);
}

async function upsertMergedPr(
	notion: NotionClient,
	event: MergedPrEvent,
	status: string,
	changedFiles: string[],
): Promise<string> {
	const existing = await findMergedPrPage(notion, {
		prNumber: event.number,
		prUrl: event.htmlUrl,
	});

	if (existing) {
		await notion.pages.update({
			page_id: existing.id,
			properties: mergedPrProperties(event, {
				status,
				changedFiles,
			}),
		} as never);
			return asString(existing.id);
	}

	const page = await notion.pages.create({
		parent: { database_id: dbId("mergedPrs") },
		properties: mergedPrProperties(event, { status, changedFiles }),
	} as never);

	return asString(page.id);
}

async function updateMergedPrPage(
	notion: NotionClient,
	pageId: string,
	update: {
		status?: string;
		changedFiles?: string[];
		impactedClaimIds?: string[];
		impactedSectionIds?: string[];
		agentSummary?: string;
		error?: string;
	},
): Promise<void> {
	const properties: Record<string, unknown> = {};
	if (update.status) properties.Status = select(update.status);
	if (update.changedFiles) properties["Changed Files"] = richText(update.changedFiles.join("\n"));
	if (update.impactedClaimIds) {
		properties["Impacted Claim IDs"] = richText(update.impactedClaimIds.join(", "));
	}
	if (update.impactedSectionIds) {
		properties["Impacted Section IDs"] = richText(update.impactedSectionIds.join(", "));
	}
	if (update.agentSummary) properties["Agent Summary"] = richText(update.agentSummary);
	if (update.error) properties.Error = richText(update.error);

	await notion.pages.update({
		page_id: pageId,
		properties,
	} as never);
}

function mergedPrProperties(
	event: MergedPrEvent,
	options: {
		status: string;
		changedFiles: string[];
	},
): Record<string, unknown> {
	return {
		Name: title(`PR #${event.number}: ${event.title}`),
		"PR Number": { number: event.number },
		"PR URL": { url: event.htmlUrl || null },
		"Base Branch": richText(event.baseBranch),
		"Merge Commit": richText(event.mergeCommitSha),
		"Changed Files": richText(options.changedFiles.join("\n")),
		Status: select(options.status),
	};
}

async function findMergedPrPage(
	notion: NotionClient,
	input: { prNumber: number | null; prUrl: string | null },
): Promise<Record<string, unknown> | null> {
	const filters: Record<string, unknown>[] = [];
	if (input.prNumber !== null) {
		filters.push({ property: "PR Number", number: { equals: input.prNumber } });
	}
	if (input.prUrl) {
		filters.push({ property: "PR URL", url: { equals: input.prUrl } });
	}

	if (filters.length === 0) {
		return null;
	}

	const response = await queryDataSource(notion, "mergedPrs", {
		filter: filters.length === 1 ? filters[0] : { or: filters },
		page_size: 1,
	});

	return (response.results[0] as Record<string, unknown> | undefined) ?? null;
}

async function queryDataSource(
	notion: NotionClient,
	key: keyof typeof DATABASES,
	args: Record<string, unknown>,
): Promise<{ results: unknown[]; has_more: boolean; next_cursor: string | null }> {
	return notion.dataSources.query({
		data_source_id: dbId(key),
		...args,
	} as never) as never;
}

function mergedPrFromPage(page: Record<string, unknown>): MergedPrRow {
	const props = pageProperties(page);
	return {
		pageId: asString(page.id),
		name: propertyTitle(props.Name),
		prNumber: propertyNumber(props["PR Number"]),
		prUrl: propertyUrl(props["PR URL"]),
		baseBranch: propertyText(props["Base Branch"]),
		mergeCommit: propertyText(props["Merge Commit"]),
		changedFiles: propertyText(props["Changed Files"]),
		status: propertySelect(props.Status),
		impactedClaimIds: propertyText(props["Impacted Claim IDs"]),
		impactedSectionIds: propertyText(props["Impacted Section IDs"]),
		agentSummary: propertyText(props["Agent Summary"]),
		error: propertyText(props.Error),
	};
}

async function changedFilesForPr(
	notion: NotionClient,
	prNumber: number | null,
): Promise<string[]> {
	if (prNumber === null) {
		return [];
	}

	const page = await findMergedPrPage(notion, { prNumber, prUrl: null });
	if (!page) {
		return [];
	}

	return splitMultiValue(asString(mergedPrFromPage(page).changedFiles));
}

async function listDocClaims(notion: NotionClient): Promise<DocClaim[]> {
	const claims: DocClaim[] = [];
	let startCursor: string | undefined;

	do {
	const response = await queryDataSource(notion, "docClaims", {
			start_cursor: startCursor,
			page_size: 100,
		});

		for (const page of response.results as Array<Record<string, unknown>>) {
			const props = pageProperties(page);
			claims.push({
				id: propertyText(props["Claim ID"]) || asString(page.id),
				pageId: asString(page.id),
				sectionId: propertyText(props["Section ID"]),
				text: propertyTitle(props.Claim),
				kind: propertySelect(props.Kind),
				status: propertySelect(props.Status),
				coveredPaths: splitMultiValue(propertyText(props["Covered Paths"])),
				concepts: splitMultiValue(propertyText(props.Concepts)),
				evidenceRefs: splitMultiValue(propertyText(props["Evidence Refs"])),
				confidence: propertyNumber(props.Confidence) || null,
			});
		}

		startCursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
	} while (startCursor);

	return claims;
}

async function findSectionById(
	notion: NotionClient,
	sectionId: string,
): Promise<DocSection | null> {
	const response = await queryDataSource(notion, "docSections", {
		filter: { property: "Section ID", rich_text: { equals: sectionId } },
		page_size: 1,
	});
	const page = response.results[0] as Record<string, unknown> | undefined;
	if (!page) {
		return null;
	}

	return sectionFromPage(page);
}

async function sectionsForClaims(
	notion: NotionClient,
	claims: DocClaim[],
): Promise<DocSection[]> {
	const sections: DocSection[] = [];
	for (const sectionId of unique(claims.map((claim) => claim.sectionId).filter(Boolean))) {
		const section = await findSectionById(notion, sectionId);
		if (section) {
			sections.push(section);
		}
	}
	return sections;
}

function sectionFromPage(page: Record<string, unknown>): DocSection {
	const props = pageProperties(page);
	return {
		id: propertyText(props["Section ID"]) || asString(page.id),
		pageId: asString(page.id),
		title: propertyTitle(props.Name),
		notionPageUrl: propertyUrl(props["Notion Page"]),
		sourceMarkdownHash: propertyText(props["Source Markdown Hash"]),
		renderedNotionHash: propertyText(props["Rendered Notion Hash"]),
		claimIds: splitMultiValue(propertyText(props["Claim IDs"])),
		status: propertySelect(props.Status),
	};
}

function rankClaimsForChangedFiles(
	event: { title: string; body: string; changedFiles: string[] },
	claims: DocClaim[],
): ClaimMatch[] {
	const corpus = `${event.title} ${event.body} ${event.changedFiles.join(" ")}`.toLowerCase();

	return claims
		.map((claim) => {
			const reasons: string[] = [];
			let score = 0;

			for (const path of claim.coveredPaths) {
				if (event.changedFiles.some((file) => pathsOverlap(file, path))) {
					score += 100;
					reasons.push(`path:${path}`);
				}
			}

			for (const evidence of claim.evidenceRefs) {
				if (event.changedFiles.some((file) => pathsOverlap(file, evidence))) {
					score += 25;
					reasons.push(`evidence:${evidence}`);
				}
			}

			for (const concept of claim.concepts) {
				if (concept.length > 1 && corpus.includes(concept.toLowerCase())) {
					score += 12;
					reasons.push(`concept:${concept}`);
				}
			}

			return { claim, score, reasons };
		})
		.filter((match) => match.score > 0)
		.sort((left, right) => right.score - left.score);
}

function pathsOverlap(changedFile: string, claimPath: string): boolean {
	const changed = normalizePath(changedFile);
	const claim = normalizePath(claimPath);
	if (!changed || !claim) return false;
	return changed === claim || changed.startsWith(`${claim}/`) || claim.startsWith(`${changed}/`);
}

async function verifyPatchProposal(
	notion: NotionClient,
	proposal: PatchProposal,
	context: {
		impactedClaimIds: Set<string>;
		impactedSectionIds: Set<string>;
	},
): Promise<{ accepted: true; reasons: string[] } | { accepted: false; reasons: string[] }> {
	if (!Array.isArray(proposal.operations) || proposal.operations.length > 5) {
		return { accepted: false, reasons: ["invalid_operation_count"] };
	}

	for (const operation of proposal.operations) {
		if (!isSupportedOperation(operation)) {
			return { accepted: false, reasons: ["unsupported_operation"] };
		}

		if (operation.type === "skip") {
			continue;
		}

		const evidenceRefs = "evidenceRefs" in operation ? operation.evidenceRefs : [];
		if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
			return { accepted: false, reasons: ["missing_evidence"] };
		}

		if (operation.type === "update_claim" || operation.type === "mark_claim_stale") {
			if (!context.impactedClaimIds.has(operation.claimId)) {
				return { accepted: false, reasons: ["claim_not_impacted"] };
			}
		}

		if (operation.type === "add_claim") {
			if (!context.impactedSectionIds.has(operation.sectionId)) {
				return { accepted: false, reasons: ["section_not_impacted"] };
			}
		}

		if (operation.type === "replace_section") {
			if (!context.impactedSectionIds.has(operation.sectionId)) {
				return { accepted: false, reasons: ["section_not_impacted"] };
			}

			if (operation.removedClaimIds && operation.removedClaimIds.length > 0) {
				return { accepted: false, reasons: ["auto_remove_not_allowed"] };
			}

			const section = await findSectionById(notion, operation.sectionId);
			if (!section) {
				return { accepted: false, reasons: ["section_not_found"] };
			}

			if (section.renderedNotionHash !== operation.expectedRenderedHash) {
				return { accepted: false, reasons: ["target_user_edited_content"] };
			}
		}
	}

	return { accepted: true, reasons: [] };
}

function parsePatchProposal(patchJson: string): PatchProposal {
	const parsed = JSON.parse(patchJson) as PatchProposal;
	if (!parsed || !Array.isArray(parsed.operations)) {
		throw new Error("Patch proposal must include an operations array");
	}
	return parsed;
}

function isSupportedOperation(operation: unknown): operation is PatchOperation {
	if (!operation || typeof operation !== "object") return false;
	const type = (operation as { type?: unknown }).type;
	return (
		type === "update_claim" ||
		type === "add_claim" ||
		type === "mark_claim_stale" ||
		type === "replace_section" ||
		type === "create_review_task" ||
		type === "skip"
	);
}

async function replaceSectionPage(
	notion: NotionClient,
	section: DocSection,
	markdown: string,
): Promise<void> {
	const pageId = notionIdFromUrl(section.notionPageUrl);
	if (!pageId) {
		throw new Error(`Could not parse Notion page ID for section ${section.id}`);
	}

	const children = await notion.blocks.children.list({
		block_id: pageId,
		page_size: 100,
	} as never);

	for (const block of children.results as Array<{ id?: string }>) {
		if (block.id) {
			await notion.blocks.delete({ block_id: block.id } as never);
		}
	}

	await notion.blocks.children.append({
		block_id: pageId,
		children: markdownToBlocks(markdown),
	} as never);

	await notion.pages.update({
		page_id: section.pageId,
		properties: {
			"Rendered Notion Hash": richText(stableHash(markdown)),
			Status: select("Managed"),
			"Last Updated By": select("NBrain"),
		},
	} as never);
}

async function updateClaimText(
	notion: NotionClient,
	claimId: string,
	text: string,
	evidenceRefs: string[],
): Promise<void> {
	const claim = await findClaimById(notion, claimId);
	if (!claim) {
		throw new Error(`Claim ${claimId} not found`);
	}

	await notion.pages.update({
		page_id: claim.pageId,
		properties: {
			Claim: title(text),
			"Evidence Refs": richText(evidenceRefs.join("\n")),
			Status: select("fresh"),
		},
	} as never);
}

async function markClaimStale(
	notion: NotionClient,
	claimId: string,
	staleStatus: "suspect" | "stale",
	evidenceRefs: string[],
): Promise<void> {
	const claim = await findClaimById(notion, claimId);
	if (!claim) {
		throw new Error(`Claim ${claimId} not found`);
	}

	await notion.pages.update({
		page_id: claim.pageId,
		properties: {
			Status: select(staleStatus),
			"Evidence Refs": richText(unique([...claim.evidenceRefs, ...evidenceRefs]).join("\n")),
		},
	} as never);
}

async function addClaim(
	notion: NotionClient,
	sectionId: string,
	claim: {
		text: string;
		kind?: string;
		coveredPaths?: string[];
		concepts?: string[];
		evidenceRefs?: string[];
		confidence?: number;
	},
	evidenceRefs: string[],
): Promise<void> {
	await notion.pages.create({
		parent: { database_id: dbId("docClaims") },
		properties: {
			Claim: title(claim.text),
			"Claim ID": richText(crypto.randomUUID()),
			"Section ID": richText(sectionId),
			Kind: select(claim.kind ?? "concept"),
			Status: select("fresh"),
			"Covered Paths": richText((claim.coveredPaths ?? []).join("\n")),
			Concepts: richText((claim.concepts ?? []).join(", ")),
			"Evidence Refs": richText(unique([...(claim.evidenceRefs ?? []), ...evidenceRefs]).join("\n")),
			Confidence: { number: claim.confidence ?? 0.5 },
		},
	} as never);
}

async function findClaimById(
	notion: NotionClient,
	claimId: string,
): Promise<DocClaim | null> {
	const response = await queryDataSource(notion, "docClaims", {
		filter: { property: "Claim ID", rich_text: { equals: claimId } },
		page_size: 1,
	});
	const page = response.results[0] as Record<string, unknown> | undefined;
	if (!page) return null;
	return (await listDocClaims(notion)).find((claim) => claim.pageId === asString(page.id)) ?? null;
}

async function createReviewTask(
	notion: NotionClient,
	input: ReviewTaskInput,
): Promise<{ id: string; url: string }> {
	const page = await notion.pages.create({
		parent: { database_id: dbId("reviewQueue") },
		properties: {
			Title: title(input.title),
			Status: select("Open"),
			Reason: richText(input.reason),
			"Unresolved Question": richText(input.unresolvedQuestion),
			"PR URL": { url: input.prUrl ?? null },
			"Changed Files": richText((input.changedFiles ?? []).join("\n")),
			"Affected Claim IDs": richText((input.affectedClaimIds ?? []).join(", ")),
			"Evidence Refs": richText((input.evidenceRefs ?? []).join("\n")),
			"Suggested Next Step": richText(input.suggestedNextStep ?? ""),
		},
	} as never);

	return { id: page.id, url: "url" in page ? String(page.url) : "" };
}

async function recordDocUpdateRun(
	notion: NotionClient,
	input: {
		prNumber: number | null;
		status: string;
		proposedOperations: string;
		appliedSectionIds: string[];
		reviewTaskIds: string[];
		logs: string[];
	},
): Promise<void> {
	await notion.pages.create({
		parent: { database_id: dbId("docUpdateRuns") },
		properties: {
			Name: title(`Doc update ${new Date().toISOString()}`),
			"Run ID": richText(crypto.randomUUID()),
			"PR Number": input.prNumber ? { number: input.prNumber } : { number: null },
			Status: select(input.status),
			"Proposed Operations": richText(input.proposedOperations),
			"Applied Section IDs": richText(input.appliedSectionIds.join(", ")),
			"Review Task IDs": richText(input.reviewTaskIds.join(", ")),
			Logs: richText(input.logs.join("\n")),
		},
	} as never);
}

function dbId(key: keyof typeof DATABASES): string {
	const value = process.env[DATABASES[key]];
	if (!value) {
		throw new Error(`${DATABASES[key]} is not configured`);
	}
	return normalizeNotionId(value);
}

function title(content: string) {
	return {
		title: [{ type: "text", text: { content: truncate(content, 1900) } }],
	};
}

function richText(content: string) {
	return {
		rich_text: [{ type: "text", text: { content: truncate(content, 1900) } }],
	};
}

function select(name: string) {
	return { select: { name } };
}

function pageProperties(page: Record<string, unknown>): Record<string, unknown> {
	return asRecord(page.properties) ?? {};
}

function propertyTitle(value: unknown): string {
	const record = asRecord(value);
	const titleItems = Array.isArray(record?.title) ? record.title : [];
	return titleItems.map((item) => asString(asRecord(item)?.plain_text)).join("");
}

function propertyText(value: unknown): string {
	const record = asRecord(value);
	const textItems = Array.isArray(record?.rich_text) ? record.rich_text : [];
	return textItems.map((item) => asString(asRecord(item)?.plain_text)).join("");
}

function propertyNumber(value: unknown): number {
	const numberValue = asRecord(value)?.number;
	return typeof numberValue === "number" ? numberValue : 0;
}

function propertyUrl(value: unknown): string {
	const urlValue = asRecord(value)?.url;
	return typeof urlValue === "string" ? urlValue : "";
}

function propertySelect(value: unknown): string {
	const selectValue = asRecord(asRecord(value)?.select);
	return asString(selectValue?.name);
}

function splitMultiValue(value: string): string[] {
	return unique(
		value
			.split(/[\n,]/)
			.map((part) => part.trim())
			.filter(Boolean),
	);
}

function markdownToBlocks(markdown: string): Array<Record<string, unknown>> {
	return markdown
		.split("\n")
		.slice(0, 90)
		.map((line) => line.trimEnd())
		.filter((line, index, lines) => line.length > 0 || index === lines.length - 1)
		.map((line) => {
			if (line.startsWith("### ")) return headingBlock("heading_3", line.slice(4));
			if (line.startsWith("## ")) return headingBlock("heading_2", line.slice(3));
			if (line.startsWith("# ")) return headingBlock("heading_1", line.slice(2));
			if (line.startsWith("- ")) {
				return {
					object: "block",
					type: "bulleted_list_item",
					bulleted_list_item: { rich_text: richTextArray(line.slice(2)) },
				};
			}
			return {
				object: "block",
				type: "paragraph",
				paragraph: { rich_text: line ? richTextArray(line) : [] },
			};
		});
}

function headingBlock(type: "heading_1" | "heading_2" | "heading_3", content: string) {
	return {
		object: "block",
		type,
		[type]: { rich_text: richTextArray(content) },
	};
}

function richTextArray(content: string) {
	return [{ type: "text", text: { content: truncate(content, 1900) } }];
}

function stableHash(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizePath(path: string): string {
	return path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeNotionId(value: string): string {
	const match = value.match(/[0-9a-fA-F]{32}/);
	return match ? match[0] : value;
}

function notionIdFromUrl(value: string): string {
	return normalizeNotionId(value);
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function truncate(content: string, maxLength: number): string {
	return content.length > maxLength ? `${content.slice(0, maxLength - 3)}...` : content;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}

function json(value: unknown): never {
	return value as never;
}
