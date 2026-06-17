import { randomUUID } from "node:crypto";

export const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;

export const nowIso = (): string => new Date().toISOString();

