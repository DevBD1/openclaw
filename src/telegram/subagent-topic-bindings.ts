import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { normalizeAccountId } from "../routing/session-key.js";

export type TelegramSubagentTopicBindingRecord = {
  accountId: string;
  chatId: string;
  topicId: string;
  targetSessionKey: string;
  label?: string;
  boundAt: number;
  expiresAt?: number;
};

type PersistedPayloadV1 = {
  version: 1;
  bindings: Record<string, TelegramSubagentTopicBindingRecord>;
  topicsByLabel?: Record<string, { topicId: string; boundAt: number }>;
};

const STATE_KEY = "__openclawTelegramSubagentTopicBindings";

type RuntimeState = {
  loadedAtMs: number;
  mtimeMs: number;
  payload: PersistedPayloadV1;
};

function defaultPayload(): PersistedPayloadV1 {
  return { version: 1, bindings: {}, topicsByLabel: {} };
}

function resolveRuntimeState(): RuntimeState {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: RuntimeState };
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      loadedAtMs: 0,
      mtimeMs: 0,
      payload: defaultPayload(),
    };
  }
  return g[STATE_KEY];
}

export function resolveTelegramSubagentTopicBindingsPath(): string {
  return path.join(resolveStateDir(process.env), "telegram", "subagent-topic-bindings.json");
}

function safeStat(filePath: string): { mtimeMs: number } | null {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function safeLoad(filePath: string): PersistedPayloadV1 {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedPayloadV1;
    if (parsed?.version !== 1 || typeof parsed.bindings !== "object" || !parsed.bindings) {
      return defaultPayload();
    }
    if (!parsed.topicsByLabel || typeof parsed.topicsByLabel !== "object") {
      parsed.topicsByLabel = {};
    }
    return parsed;
  } catch {
    return defaultPayload();
  }
}

function ensureLoaded(opts?: { maxAgeMs?: number }) {
  const state = resolveRuntimeState();
  const maxAgeMs = opts?.maxAgeMs ?? 3_000;
  const now = Date.now();
  const filePath = resolveTelegramSubagentTopicBindingsPath();
  const st = safeStat(filePath);

  const shouldReload =
    now - state.loadedAtMs > maxAgeMs || (st && st.mtimeMs && st.mtimeMs !== state.mtimeMs);

  if (!shouldReload) {
    return;
  }

  const payload = safeLoad(filePath);
  state.payload = payload;
  state.loadedAtMs = now;
  state.mtimeMs = st?.mtimeMs ?? 0;
}

function toBindingKey(params: { accountId?: string; chatId: string; topicId: string }): string {
  const accountId = normalizeAccountId(params.accountId);
  return `${accountId}:${String(params.chatId).trim()}:${String(params.topicId).trim()}`;
}

export function resolveBoundSessionForTelegramTopic(params: {
  accountId?: string;
  chatId: string | number;
  topicId?: string | number;
}): { targetSessionKey: string; label?: string } | null {
  const topicId =
    params.topicId != null && params.topicId !== "" ? String(params.topicId).trim() : "";
  if (!topicId) {
    return null;
  }
  ensureLoaded();
  const state = resolveRuntimeState();
  const key = toBindingKey({
    accountId: params.accountId,
    chatId: String(params.chatId),
    topicId,
  });
  const record = state.payload.bindings[key];
  if (!record?.targetSessionKey?.trim()) {
    return null;
  }
  if (record.expiresAt && record.expiresAt > 0 && Date.now() > record.expiresAt) {
    return null;
  }
  return { targetSessionKey: record.targetSessionKey, label: record.label };
}
