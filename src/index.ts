import "dotenv/config";
import {
  WorkerOptions,
  cli,
  defineAgent,
  type JobContext,
} from "@livekit/agents";
import { RoomEvent, DataPacketKind, type RemoteParticipant } from "@livekit/rtc-node";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "node:url";

const SYSTEM_PROMPT = `You are Clawd, a friendly and encouraging coding tutor in Tech World - a multiplayer game where players learn programming together.

Your personality:
- Warm and approachable, like a supportive friend who happens to know a lot about coding
- Patient and never condescending - everyone was a beginner once
- Enthusiastic about coding without being overwhelming
- Use casual, conversational language (avoid overly formal or academic tone)

Your teaching style:
- Give hints and guide thinking rather than providing complete solutions
- Ask clarifying questions to understand what the player is trying to achieve
- Celebrate small wins and progress
- Break complex concepts into digestible pieces
- Use analogies and real-world examples when helpful

Keep responses concise (2-4 sentences usually) since this is a chat in a game. Be helpful but don't write essays. If someone asks a complex question, offer to break it down into parts.

You're in a shared chat room - multiple players can see your responses, so sometimes you might address the group or reference that others might find the explanation useful too.`;

const CHALLENGE_EVALUATION_PROMPT = `You are Clawd, a coding tutor evaluating a challenge submission in Tech World.

Review the player's code and determine if it correctly solves the challenge. Be encouraging either way.

- If the code is correct and solves the challenge, congratulate the player briefly.
- If the code is incorrect or incomplete, explain what's wrong and give a hint to fix it.

IMPORTANT: At the very end of your response, on its own line, output exactly one of these tags:
<!-- CHALLENGE_RESULT: {"result":"pass"} -->
<!-- CHALLENGE_RESULT: {"result":"fail"} -->

Do NOT include any text after the tag. The tag must be the last thing in your response.`;

/**
 * Parses the structured challenge result tag from Claude's response.
 * Returns the clean text (without the tag) and the result ("pass" or "fail").
 */
function parseChallengeResult(text: string): {
  cleanText: string;
  result: "pass" | "fail" | null;
} {
  const match = text.match(
    /<!-- CHALLENGE_RESULT:\s*(\{[^}]+\})\s*-->\s*$/
  );
  if (!match) {
    return { cleanText: text, result: null };
  }
  try {
    const parsed = JSON.parse(match[1]);
    const result = parsed.result === "pass" ? "pass" : parsed.result === "fail" ? "fail" : null;
    const cleanText = text.slice(0, match.index).trimEnd();
    return { cleanText, result };
  } catch {
    return { cleanText: text, result: null };
  }
}

const anthropic = new Anthropic();

// --- World state ---

/** Grid defaults — overwritten when map-info arrives from a client. */
const DEFAULT_GRID_SIZE = 50;
const DEFAULT_CELL_SIZE = 32;
const DEFAULT_SPAWN = { x: 25, y: 25 };

interface MapInfo {
  mapId: string;
  barriers: [number, number][];
  terminals: [number, number][];
  spawnPoint: { x: number; y: number };
  gridSize: number;
  cellSize: number;
}

/** Mutable world state, scoped per room inside `entry`. */
interface WorldState {
  map: MapInfo | null;
  /** Clawd's current position in mini-grid coordinates. */
  position: { x: number; y: number };
}

/** Convert a mini-grid coordinate to pixel position. */
function gridToPixel(
  gridX: number,
  gridY: number,
  cellSize: number = DEFAULT_CELL_SIZE
): { x: number; y: number } {
  return { x: gridX * cellSize, y: gridY * cellSize };
}

/** Publish Clawd's current position on the `position` data channel. */
async function publishPosition(
  ctx: JobContext,
  world: WorldState,
  cellSize: number = DEFAULT_CELL_SIZE
): Promise<void> {
  const pixel = gridToPixel(world.position.x, world.position.y, cellSize);
  const payload = {
    playerId: "bot-claude",
    points: [{ x: pixel.x, y: pixel.y }],
    directions: ["none"],
  };

  const encoder = new TextEncoder();
  await ctx.agent?.publishData(encoder.encode(JSON.stringify(payload)), {
    topic: "position",
    reliable: false,
  });

  console.log(
    `[Position] Published: grid(${world.position.x},${world.position.y}) → pixel(${pixel.x},${pixel.y})`
  );
}

// --- Chat ---

// Message history for context (per room)
interface MessageContext {
  role: "user" | "assistant";
  content: string;
}
const MAX_HISTORY = 20; // Keep last 20 messages for context

async function handleChatMessage(
  ctx: JobContext,
  messageHistory: MessageContext[],
  senderId: string,
  senderName: string,
  messageId: string,
  text: string,
  challengeId?: string
): Promise<void> {
  console.log(`[Chat] ${senderName} (${senderId}): ${text}${challengeId ? ` [challenge: ${challengeId}]` : ""}`);

  const isChallenge = !!challengeId;

  // Only add to conversation history for regular chat (not challenge evaluations)
  if (!isChallenge) {
    messageHistory.push({
      role: "user",
      content: `${senderName}: ${text}`,
    });

    // Trim history if too long
    while (messageHistory.length > MAX_HISTORY) {
      messageHistory.shift();
    }
  }

  try {
    // Call Claude API — use evaluation prompt for challenges, regular prompt otherwise
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: isChallenge ? CHALLENGE_EVALUATION_PROMPT : SYSTEM_PROMPT,
      messages: isChallenge
        ? [{ role: "user", content: text }]
        : messageHistory,
    });

    // Extract text from response
    const rawText =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Parse challenge result if this is a challenge evaluation
    let responseText = rawText;
    let challengeResult: "pass" | "fail" | null = null;
    if (isChallenge) {
      const parsed = parseChallengeResult(rawText);
      responseText = parsed.cleanText;
      challengeResult = parsed.result;
      console.log(`[Challenge] ${challengeId}: ${challengeResult ?? "no result parsed"}`);
    }

    // Only add to history for regular chat
    if (!isChallenge) {
      messageHistory.push({
        role: "assistant",
        content: responseText,
      });
    }

    // Build response payload
    const payload: Record<string, unknown> = {
      type: "chat-response",
      id: `${messageId}-response`,
      messageId: messageId,
      text: responseText,
      senderName: "Clawd",
      timestamp: new Date().toISOString(),
    };
    if (challengeId) payload.challengeId = challengeId;
    if (challengeResult) payload.challengeResult = challengeResult;

    const encoder = new TextEncoder();
    await ctx.agent?.publishData(
      encoder.encode(JSON.stringify(payload)),
      {
        topic: "chat-response",
        reliable: true,
      }
    );

    console.log(
      `[Response] Sent: "${responseText.substring(0, 50)}..."`
    );
  } catch (error) {
    console.error("[Error] Failed to get Claude response:", error);

    // Send error message back
    const errorPayload = JSON.stringify({
      type: "chat-response",
      id: `${messageId}-error`,
      messageId: messageId,
      text: "Oops, I had a brain freeze! Could you try asking again?",
      senderName: "Clawd",
      timestamp: new Date().toISOString(),
    });

    const encoder = new TextEncoder();
    await ctx.agent?.publishData(encoder.encode(errorPayload), {
      topic: "chat-response",
      reliable: true,
    });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    console.log("[Bot] Connecting to room...");
    await ctx.connect();
    console.log(`[Bot] Connected to room: ${ctx.room.name}`);

    const room = ctx.room;

    // Scoped per room instance to prevent context leaking across restarts.
    const messageHistory: MessageContext[] = [];
    const world: WorldState = {
      map: null,
      position: { ...DEFAULT_SPAWN },
    };

    // Publish initial position at default spawn so the client can render us.
    await publishPosition(ctx, world);

    // Exit on disconnect so PM2 can restart us.
    room.on(RoomEvent.Disconnected, (reason) => {
      console.log(`[Bot] Room disconnected: ${String(reason)}. Shutting down for PM2 restart.`);
      process.exit(1);
    });

    // Listen for data messages
    room.on(
      RoomEvent.DataReceived,
      (
        payload: Uint8Array,
        participant?: RemoteParticipant,
        _kind?: DataPacketKind,
        topic?: string
      ) => {
        // Ignore messages from ourselves
        if (participant?.identity === "bot-claude") return;

        const decoder = new TextDecoder();

        // --- Map info from client ---
        if (topic === "map-info") {
          try {
            const message = JSON.parse(decoder.decode(payload));
            world.map = {
              mapId: message.mapId as string,
              barriers: message.barriers as [number, number][],
              terminals: message.terminals as [number, number][],
              spawnPoint: {
                x: message.spawnPoint[0] as number,
                y: message.spawnPoint[1] as number,
              },
              gridSize: (message.gridSize as number) || DEFAULT_GRID_SIZE,
              cellSize: (message.cellSize as number) || DEFAULT_CELL_SIZE,
            };

            // Move to the map's spawn point
            world.position = { ...world.map.spawnPoint };

            console.log(
              `[Map] Received map-info: ${world.map.mapId} ` +
                `(${world.map.barriers.length} barriers, ` +
                `${world.map.terminals.length} terminals, ` +
                `spawn: ${world.map.spawnPoint.x},${world.map.spawnPoint.y})`
            );

            // Re-publish position at the correct spawn
            publishPosition(ctx, world, world.map.cellSize).catch((err) =>
              console.error("[Position] Failed to publish:", err)
            );
          } catch (error) {
            console.error("[Map] Error parsing map-info:", error);
          }
          return;
        }

        // --- Chat messages ---
        if (topic === "chat") {
          try {
            const message = JSON.parse(decoder.decode(payload));

            const text = message.text as string;
            const messageId = message.id as string;
            const senderName =
              (message.senderName as string) ||
              participant?.name ||
              participant?.identity ||
              "Unknown";
            const senderId = participant?.identity || "unknown";

            if (!text || !messageId) {
              console.warn("[Bot] Received malformed message:", message);
              return;
            }

            const challengeId = message.challengeId as string | undefined;

            // Handle asynchronously - don't await in event handler
            handleChatMessage(ctx, messageHistory, senderId, senderName, messageId, text, challengeId).catch(
              (error) => console.error("[Bot] Error handling message:", error)
            );
          } catch (error) {
            console.error("[Bot] Error parsing chat message:", error);
          }
        }
      }
    );

    // Log when participants join/leave
    room.on(RoomEvent.ParticipantConnected, (participant) => {
      console.log(`[Bot] Participant joined: ${participant.identity}`);
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      console.log(`[Bot] Participant left: ${participant.identity}`);
    });

    console.log("[Bot] Ready and listening for chat messages");

    // Keep the agent running
    await new Promise(() => {});
  },
});

// Run the agent when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(
    new WorkerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: "clawd",
      requestFunc: async (req) => {
        // Accept with custom identity "bot-claude"
        await req.accept("Clawd", "bot-claude");
      },
    })
  );
}
