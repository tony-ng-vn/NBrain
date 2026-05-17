import { createHash } from "node:crypto";

export function stableHash(value: unknown): string {
  const input = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(input).digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

export function notionRenderedHash(markdown: string): string {
  return stableHash(notionComparableTextFromMarkdown(markdown));
}

export function notionComparableTextFromMarkdown(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/^-\s+/, ""))
    .join("\n");
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortObject(nested)]),
    );
  }

  return value;
}
