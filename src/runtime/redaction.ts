export const redactText = (text: string): string =>
  text
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(
      /\b([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Za-z0-9_]*=)([^\s]+)/gi,
      "$1[REDACTED]"
    )
    .replace(/\b(Bearer\s+)([A-Za-z0-9._~+/-]+=*)\b/g, "$1[REDACTED]");
