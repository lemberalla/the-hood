import type { JsonObject } from "../runtime/types.js";

export const agentMarkdownField = "markdown";
export const agentMarkdownTruncatedField = "markdownTruncated";
export const agentMarkdownCharLengthField = "markdownCharLength";

export const agentMarkdownFieldDescription =
  "Human-facing markdown for plans, reports, reviews, rationale, or other narrative content. Keep mechanical control fields outside this markdown.";

export const extractAgentMarkdown = (payload: JsonObject | undefined): string | undefined => {
  const value = payload?.[agentMarkdownField];

  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

const isJsonObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const boundMarkdownField = (payload: JsonObject, maxChars: number): void => {
  const markdown = payload[agentMarkdownField];

  if (typeof markdown !== "string" || markdown.length <= maxChars) {
    return;
  }

  payload[agentMarkdownField] = markdown.slice(0, maxChars);
  payload[agentMarkdownTruncatedField] = true;
  payload[agentMarkdownCharLengthField] = markdown.length;
};

export const boundAgentMarkdownPayloads = (data: JsonObject, maxChars: number): JsonObject => {
  const bounded = JSON.parse(JSON.stringify(data)) as JsonObject;

  boundMarkdownField(bounded, maxChars);

  for (const value of Object.values(bounded)) {
    if (isJsonObject(value)) {
      boundMarkdownField(value, maxChars);
    }
  }

  return bounded;
};
