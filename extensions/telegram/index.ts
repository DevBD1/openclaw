import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { telegramPlugin } from "./src/channel.js";
import { setTelegramRuntime } from "./src/runtime.js";

const plugin = {
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTelegramRuntime(api.runtime);
    api.registerChannel({ plugin: telegramPlugin as ChannelPlugin });

    // Telegram thread-bound subagent sessions (requires Telegram supergroup Topics).
    // This registers the hooks required by sessions_spawn({ thread:true, mode:"session" }).
    api.on("subagent_spawning", async (event) => {
      if (!event.threadRequested || event.mode !== "session") {
        return;
      }
      if (event.requester?.channel?.toLowerCase() !== "telegram") {
        return;
      }
      const cfg = api.config;
      const accountId = (event.requester.accountId ?? "default").trim() || "default";
      const chatId = (event.requester.to ?? "").trim();
      if (!chatId) {
        return { status: "error", error: "Telegram thread binding requires requester.to (chat id)." };
      }

      const threadBindings =
        cfg.channels?.telegram?.accounts?.[accountId]?.threadBindings ??
        cfg.channels?.telegram?.threadBindings;
      const enabled = threadBindings?.enabled !== false;
      const spawnEnabled = threadBindings?.spawnSubagentSessions === true;
      if (!enabled || !spawnEnabled) {
        return {
          status: "error",
          error:
            "Telegram thread-bound subagent sessions are disabled. Set channels.telegram.threadBindings.spawnSubagentSessions=true (and ensure Topics are enabled).",
        };
      }

      const label = (event.label ?? "Subagent").trim() || "Subagent";

      // Persist bindings under the OpenClaw state dir so core Telegram inbound routing can resolve them.
      const stateDir = api.runtime.state.resolveStateDir(process.env);
      const fs = await import("node:fs");
      const path = await import("node:path");
      const bindingsPath = path.join(stateDir, "telegram", "subagent-topic-bindings.json");
      fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });

      type Payload = {
        version: 1;
        bindings: Record<
          string,
          {
            accountId: string;
            chatId: string;
            topicId: string;
            targetSessionKey: string;
            label?: string;
            boundAt: number;
            expiresAt?: number;
          }
        >;
        topicsByLabel?: Record<string, { topicId: string; boundAt: number }>;
      };

      const normalizeAccountId = (raw?: string) => (raw ?? "default").trim().toLowerCase();
      const acc = normalizeAccountId(accountId);
      const loadPayload = (): Payload => {
        try {
          const raw = fs.readFileSync(bindingsPath, "utf8");
          const parsed = JSON.parse(raw) as Payload;
          if (parsed?.version !== 1 || !parsed.bindings || typeof parsed.bindings !== "object") {
            return { version: 1, bindings: {}, topicsByLabel: {} };
          }
          if (!parsed.topicsByLabel || typeof parsed.topicsByLabel !== "object") {
            parsed.topicsByLabel = {};
          }
          return parsed;
        } catch {
          return { version: 1, bindings: {}, topicsByLabel: {} };
        }
      };
      const savePayload = (payload: Payload) => {
        fs.writeFileSync(bindingsPath, JSON.stringify(payload, null, 2));
      };

      const payload = loadPayload();
      const labelKey = `${acc}:${chatId}:${label}`;
      const existingTopicId = payload.topicsByLabel?.[labelKey]?.topicId;

      let topicId: string | null = existingTopicId ?? null;
      if (!topicId) {
        // Create a new forum topic.
        const result = await api.runtime.channel.telegram.messageActions.handleAction({
          providerId: "telegram",
          action: "topic-create",
          params: {
            chatId,
            name: label,
            accountId,
          },
          cfg,
        });
        // Result is provider-defined; we expect { ok:true, topicId, chatId, name }.
        const parsed = typeof result === "string" ? JSON.parse(result) : (result as any);
        const id = parsed?.topicId ?? parsed?.result?.topicId;
        if (id == null) {
          return {
            status: "error",
            error: "Failed to create Telegram forum topic for subagent session (missing topicId).",
          };
        }
        topicId = String(id);
        payload.topicsByLabel = payload.topicsByLabel ?? {};
        payload.topicsByLabel[labelKey] = { topicId, boundAt: Date.now() };
      }

      const bindingKey = `${acc}:${chatId}:${topicId}`;
      payload.bindings[bindingKey] = {
        accountId: acc,
        chatId,
        topicId,
        targetSessionKey: event.childSessionKey,
        label,
        boundAt: Date.now(),
      };
      savePayload(payload);

      return { status: "ok", threadBindingReady: true };
    });

    api.on("subagent_delivery_target", async (event) => {
      // If this subagent has a bound Telegram topic, deliver completion announcements into that topic.
      const cfg = api.config;
      const accountId = (event.requesterOrigin?.accountId ?? "default").trim() || "default";
      const stateDir = api.runtime.state.resolveStateDir(process.env);
      const fs = await import("node:fs");
      const path = await import("node:path");
      const bindingsPath = path.join(stateDir, "telegram", "subagent-topic-bindings.json");

      let payload: any;
      try {
        payload = JSON.parse(fs.readFileSync(bindingsPath, "utf8"));
      } catch {
        return;
      }
      const bindings = payload?.bindings;
      if (!bindings || typeof bindings !== "object") {
        return;
      }
      const acc = (accountId ?? "default").trim().toLowerCase();
      const match = Object.values(bindings).find(
        (b: any) =>
          b &&
          typeof b === "object" &&
          b.accountId === acc &&
          b.targetSessionKey === event.childSessionKey,
      ) as any;
      if (!match?.chatId || !match?.topicId) {
        return;
      }
      return {
        origin: {
          channel: "telegram",
          accountId,
          to: String(match.chatId),
          threadId: String(match.topicId),
        },
      };
    });
  },
};

export default plugin;
