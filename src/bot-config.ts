/** Bot configuration — drives identity, prompts, and behavior per bot instance. */

export interface BotConfig {
  /** LiveKit agent name (lowercase) — must match dispatch config. */
  agentName: string;
  /** LiveKit participant identity — used for position publishing and self-filtering. */
  identity: string;
  /** Human-readable display name — used in chat responses. */
  displayName: string;
  /** System prompt for chat interactions. */
  systemPrompt: string;
  /** Challenge evaluation prompt, or null if this bot doesn't evaluate. */
  challengeEvalPrompt: string | null;
  /** Help hint prompt, or null if this bot doesn't give hints. */
  helpHintPrompt: string | null;
  /** Proactive nudge prompt for stuck player detection. */
  proactiveNudgePrompt: string;
  /** Whether this bot responds to all chat messages (true) or only when addressed by name (false). */
  respondsToAll: boolean;
  /** Wandering behavior tuning. */
  wanderConfig: {
    minPauseMs: number;
    maxPauseMs: number;
    maxPathLength: number;
  };
}

import * as clawd from "./prompts/clawd.js";
import * as gremlin from "./prompts/gremlin.js";

const configs: Record<string, BotConfig> = {
  clawd: {
    agentName: "clawd",
    identity: "bot-claude",
    displayName: "Clawd",
    systemPrompt: clawd.SYSTEM_PROMPT,
    challengeEvalPrompt: clawd.CHALLENGE_EVALUATION_PROMPT,
    helpHintPrompt: clawd.HELP_HINT_PROMPT,
    proactiveNudgePrompt: clawd.PROACTIVE_NUDGE_PROMPT,
    respondsToAll: true,
    wanderConfig: {
      minPauseMs: 2_000,
      maxPauseMs: 5_000,
      maxPathLength: 20,
    },
  },
  gremlin: {
    agentName: "gremlin",
    identity: "bot-gremlin",
    displayName: "Gremlin",
    systemPrompt: gremlin.SYSTEM_PROMPT,
    challengeEvalPrompt: gremlin.CHALLENGE_EVALUATION_PROMPT,
    helpHintPrompt: gremlin.HELP_HINT_PROMPT,
    proactiveNudgePrompt: gremlin.PROACTIVE_NUDGE_PROMPT,
    respondsToAll: false,
    wanderConfig: {
      minPauseMs: 1_000,
      maxPauseMs: 3_000,
      maxPathLength: 25,
    },
  },
};

/**
 * Resolve the bot config from CLI arguments or environment.
 *
 * Checks (in order):
 * 1. `--bot=<name>` CLI argument
 * 2. `BOT_NAME` environment variable (used by Cloud Run)
 * 3. Falls back to "clawd"
 */
export function resolveBotConfig(): BotConfig {
  const botArg = process.argv.find((arg) => arg.startsWith("--bot="));
  const botName = botArg ? botArg.split("=")[1] : (process.env.BOT_NAME || "clawd");

  const config = configs[botName];
  if (!config) {
    const valid = Object.keys(configs).join(", ");
    throw new Error(`Unknown bot "${botName}". Valid options: ${valid}`);
  }

  console.log(`[Config] Loaded bot config: ${config.displayName} (${config.identity})`);
  return config;
}
