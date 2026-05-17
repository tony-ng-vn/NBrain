import { createHash } from "node:crypto";

export function stableHash(value: unknown): string {
  const input = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(input).digest("hex");
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortObject(value));
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
