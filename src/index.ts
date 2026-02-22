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
import {
  startWandering,
  startStuckDetection,
  publishPath,
  abortableSleep,
  findAdjacentCell,
  STEP_DURATION_MS,
  type WorldState,
  type PlayerTerminalState,
} from "./agent-loop.js";
import {
  findPath,
  buildBarrierSet,
  pathToDirections,
  pathToPixels,
} from "./pathfinding.js";

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

const HELP_HINT_PROMPT = `You are Clawd, a friendly coding tutor in Tech World. A player is stuck on a coding challenge and has asked for help.

Give ONE specific, actionable hint that nudges them in the right direction. Do NOT give the full solution or write the code for them.

Guidelines:
- Point out what concept or approach they should think about
- If their code has a specific bug, hint at where to look without fixing it
- If their code is empty, suggest what to start with
- Keep it to 2-3 sentences max
- Be encouraging — getting stuck is part of learning!`;

const PROACTIVE_NUDGE_PROMPT = `You are Clawd, a friendly coding tutor in a multiplayer game. A player has been working on a coding challenge for a couple of minutes. Write a brief, encouraging check-in message (1-2 sentences). Mention the challenge by name. Don't give hints yet — just offer to help. Keep it casual and warm.`;

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

/** Handle a help-request: walk to the terminal, call Claude for a hint, publish the response. */
async function handleHelpRequest(
  ctx: JobContext,
  world: WorldState,
  wanderControllerRef: { current: AbortController },
  message: Record<string, unknown>
): Promise<void> {
  const requestId = message.id as string;
  const challengeTitle = message.challengeTitle as string;
  const challengeDescription = message.challengeDescription as string;
  const code = message.code as string;
  const terminalX = message.terminalX as number;
  const terminalY = message.terminalY as number;
  const senderName = message.senderName as string;

  console.log(`[Help] Request ${requestId} from ${senderName} for terminal at (${terminalX},${terminalY})`);

  // 1. Abort wandering
  wanderControllerRef.current.abort();

  const map = world.map;
  if (!map) {
    console.warn("[Help] No map data available, sending hint from current position");
    await sendHint(ctx, requestId, challengeTitle, challengeDescription, code);
    wanderControllerRef.current = startWandering(ctx, world);
    return;
  }

  const barrierSet = buildBarrierSet(map.barriers);

  // 2. Find walkable cell adjacent to the terminal
  const targetCell = findAdjacentCell(
    { x: terminalX, y: terminalY },
    barrierSet,
    map.gridSize
  );

  // 3. Start Claude API call in parallel with walking
  const hintPromise = callClaudeForHint(challengeTitle, challengeDescription, code);

  // 4. Walk to the terminal (if we have a valid target and aren't already there)
  if (targetCell) {
    const alreadyAdjacent =
      Math.max(
        Math.abs(world.position.x - terminalX),
        Math.abs(world.position.y - terminalY)
      ) <= 1;

    if (!alreadyAdjacent) {
      const path = findPath(world.position, targetCell, barrierSet, map.gridSize);

      if (path.length >= 2) {
        const directions = pathToDirections(path);
        const points = pathToPixels(path, map.cellSize);

        console.log(
          `[Help] Walking to terminal: (${world.position.x},${world.position.y}) → ` +
            `(${targetCell.x},${targetCell.y}) (${directions.length} steps)`
        );

        try {
          await publishPath(ctx, points, directions);
        } catch (err) {
          console.error("[Help] Failed to publish path:", err);
        }

        // 5. Wait for walk to complete
        const walkDuration = directions.length * STEP_DURATION_MS;
        await new Promise((resolve) => setTimeout(resolve, walkDuration));

        // Update position
        const end = path[path.length - 1];
        world.position = { x: end.x, y: end.y };
      }
    } else {
      console.log("[Help] Already adjacent to terminal, skipping walk");
    }
  } else {
    console.warn("[Help] No walkable cell adjacent to terminal, sending hint from current position");
  }

  // 6. Await the hint from Claude
  const hint = await hintPromise;

  // 7. Publish hint on help-response topic
  const payload = {
    type: "help-response",
    requestId,
    hint,
    timestamp: new Date().toISOString(),
  };

  const encoder = new TextEncoder();
  await ctx.agent?.publishData(encoder.encode(JSON.stringify(payload)), {
    topic: "help-response",
    reliable: true,
  });

  console.log(`[Help] Sent hint for ${requestId}: "${hint.substring(0, 60)}..."`);

  // 8. Linger near the terminal for 10 seconds, then resume wandering
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  wanderControllerRef.current = startWandering(ctx, world);
}

/** Call Claude API to generate a hint for a coding challenge. */
async function callClaudeForHint(
  challengeTitle: string,
  challengeDescription: string,
  code: string
): Promise<string> {
  try {
    const userMessage = code.trim()
      ? `Challenge: "${challengeTitle}"\nDescription: ${challengeDescription}\n\nPlayer's current code:\n\`\`\`dart\n${code}\n\`\`\``
      : `Challenge: "${challengeTitle}"\nDescription: ${challengeDescription}\n\nThe player hasn't written any code yet.`;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: HELP_HINT_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });

    return response.content[0].type === "text"
      ? response.content[0].text
      : "Hmm, I had trouble thinking of a hint. Try breaking the problem into smaller steps!";
  } catch (error) {
    console.error("[Help] Claude API error:", error);
    return "Oops, I had a brain freeze! Try breaking the problem into smaller steps and tackle them one at a time.";
  }
}

/** Shortcut: call Claude for a hint and publish it (used when no map is available). */
async function sendHint(
  ctx: JobContext,
  requestId: string,
  challengeTitle: string,
  challengeDescription: string,
  code: string
): Promise<void> {
  const hint = await callClaudeForHint(challengeTitle, challengeDescription, code);

  const payload = {
    type: "help-response",
    requestId,
    hint,
    timestamp: new Date().toISOString(),
  };

  const encoder = new TextEncoder();
  await ctx.agent?.publishData(encoder.encode(JSON.stringify(payload)), {
    topic: "help-response",
    reliable: true,
  });
}

/** Handle a proactively detected stuck player: walk to terminal, send nudge, resume wandering. */
async function handleProactiveApproach(
  ctx: JobContext,
  world: WorldState,
  wanderControllerRef: { current: AbortController },
  trackedPlayers: Map<string, PlayerTerminalState>,
  player: PlayerTerminalState,
  proactiveControllerRef: { current: AbortController | null },
): Promise<void> {
  console.log(
    `[Proactive] Approaching ${player.playerName} at terminal (${player.terminalX},${player.terminalY})`
  );

  // Create an abort controller for this proactive approach so help-requests can cancel it.
  const controller = new AbortController();
  proactiveControllerRef.current = controller;

  // 1. Abort wandering
  wanderControllerRef.current.abort();

  const map = world.map;
  if (!map) {
    console.warn("[Proactive] No map data, skipping approach");
    player.proactiveOffered = true;
    proactiveControllerRef.current = null;
    wanderControllerRef.current = startWandering(ctx, world);
    return;
  }

  const barrierSet = buildBarrierSet(map.barriers);

  // 2. Find adjacent walkable cell to terminal
  const targetCell = findAdjacentCell(
    { x: player.terminalX, y: player.terminalY },
    barrierSet,
    map.gridSize,
  );

  // 3. Walk to the terminal
  if (targetCell && !controller.signal.aborted) {
    const alreadyAdjacent =
      Math.max(
        Math.abs(world.position.x - player.terminalX),
        Math.abs(world.position.y - player.terminalY),
      ) <= 1;

    if (!alreadyAdjacent) {
      const path = findPath(world.position, targetCell, barrierSet, map.gridSize);

      if (path.length >= 2) {
        const directions = pathToDirections(path);
        const points = pathToPixels(path, map.cellSize);

        console.log(
          `[Proactive] Walking to terminal: (${world.position.x},${world.position.y}) → ` +
            `(${targetCell.x},${targetCell.y}) (${directions.length} steps)`
        );

        try {
          await publishPath(ctx, points, directions);
        } catch (err) {
          console.error("[Proactive] Failed to publish path:", err);
        }

        // Wait for walk to complete
        const walkDuration = directions.length * STEP_DURATION_MS;
        const completed = await abortableSleep(walkDuration, controller.signal);
        if (!completed) {
          console.log("[Proactive] Walk aborted");
          proactiveControllerRef.current = null;
          wanderControllerRef.current = startWandering(ctx, world);
          return;
        }

        // Update position
        const end = path[path.length - 1];
        world.position = { x: end.x, y: end.y };
      }
    }
  }

  // 4. Check that the player is still at the terminal and we weren't aborted
  if (!trackedPlayers.has(player.playerId) || controller.signal.aborted) {
    console.log("[Proactive] Player left terminal or approach aborted, skipping nudge");
    proactiveControllerRef.current = null;
    wanderControllerRef.current = startWandering(ctx, world);
    return;
  }

  // 5. Call Claude API for a natural nudge message
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: PROACTIVE_NUDGE_PROMPT,
      messages: [{
        role: "user",
        content: `Player name: ${player.playerName}\nChallenge title: "${player.challengeTitle}"`,
      }],
    });

    // Re-check abort after API call (help-request may have arrived while waiting)
    if (controller.signal.aborted || !trackedPlayers.has(player.playerId)) {
      console.log("[Proactive] Aborted during API call, skipping nudge");
      proactiveControllerRef.current = null;
      wanderControllerRef.current = startWandering(ctx, world);
      return;
    }

    const nudgeText =
      response.content[0].type === "text"
        ? response.content[0].text
        : "Hey! How's it going with that challenge? Let me know if you'd like a hint!";

    // 6. Publish nudge on chat-response topic
    const payload = {
      type: "chat-response",
      id: `proactive-${player.playerId}-${Date.now()}`,
      text: nudgeText,
      senderName: "Clawd",
      proactive: true,
      timestamp: new Date().toISOString(),
    };

    const encoder = new TextEncoder();
    await ctx.agent?.publishData(encoder.encode(JSON.stringify(payload)), {
      topic: "chat-response",
      reliable: true,
    });

    console.log(`[Proactive] Sent nudge to ${player.playerName}: "${nudgeText.substring(0, 60)}..."`);
  } catch (error) {
    console.error("[Proactive] Failed to send nudge:", error);
  }

  // 7. Mark proactive as offered
  player.proactiveOffered = true;

  // 8. Linger near the terminal for 10 seconds, then resume wandering
  await abortableSleep(10_000, controller.signal);
  proactiveControllerRef.current = null;
  wanderControllerRef.current = startWandering(ctx, world);
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

    // Player terminal tracking for proactive pair-programming.
    const trackedPlayers = new Map<string, PlayerTerminalState>();
    const proactiveControllerRef: { current: AbortController | null } = { current: null };
    let isBusy = false;

    // Publish initial position at default spawn so the client can render us.
    await publishPosition(ctx, world);

    // Start the autonomous wandering loop (waits for map-info internally).
    // Wrapped in a ref so help-request handlers can abort and restart it.
    const wanderControllerRef = { current: startWandering(ctx, world) };

    // Start the stuck detection loop for proactive pair-programming.
    const stuckDetectionController = startStuckDetection(
      trackedPlayers,
      async (player) => {
        // Skip if already busy with a help request or another proactive approach.
        if (isBusy || proactiveControllerRef.current) return;

        isBusy = true;
        try {
          await handleProactiveApproach(
            ctx,
            world,
            wanderControllerRef,
            trackedPlayers,
            player,
            proactiveControllerRef,
          );
        } finally {
          isBusy = false;
        }
      },
    );

    // Exit on disconnect so PM2 can restart us.
    room.on(RoomEvent.Disconnected, (reason) => {
      console.log(`[Bot] Room disconnected: ${String(reason)}. Shutting down for PM2 restart.`);
      wanderControllerRef.current.abort();
      stuckDetectionController.abort();
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

        // --- Terminal activity (editor open/close) ---
        if (topic === "terminal-activity") {
          try {
            const message = JSON.parse(decoder.decode(payload));
            // Use participant identity as the canonical key for consistency
            // with ParticipantDisconnected cleanup.
            const identity = participant?.identity || (message.playerId as string);
            const action = message.action as string;

            if (action === "open") {
              trackedPlayers.set(identity, {
                playerId: identity,
                playerName: (message.playerName as string) || "Unknown",
                challengeId: message.challengeId as string,
                challengeTitle: message.challengeTitle as string,
                challengeDescription: message.challengeDescription as string,
                terminalX: message.terminalX as number,
                terminalY: message.terminalY as number,
                openedAt: Date.now(),
                proactiveOffered: false,
                helpRequestActive: false,
              });
              console.log(
                `[Terminal] ${message.playerName} opened editor for "${message.challengeTitle}" ` +
                  `at (${message.terminalX},${message.terminalY})`
              );
            } else if (action === "close") {
              trackedPlayers.delete(identity);
              console.log(`[Terminal] ${identity} closed editor`);
            }
          } catch (error) {
            console.error("[Terminal] Error parsing terminal-activity:", error);
          }
          return;
        }

        // --- Help requests ---
        if (topic === "help-request") {
          try {
            const message = JSON.parse(decoder.decode(payload));

            // Mark help as active so stuck detection skips this player.
            const identity = participant?.identity || "";
            const tracked = trackedPlayers.get(identity);
            if (tracked) {
              tracked.helpRequestActive = true;
            }

            // If a proactive approach to a different player is in progress, abort it.
            if (proactiveControllerRef.current) {
              console.log("[Help] Aborting proactive approach for incoming help request");
              proactiveControllerRef.current.abort();
              proactiveControllerRef.current = null;
            }

            isBusy = true;
            handleHelpRequest(ctx, world, wanderControllerRef, message)
              .catch((error) => console.error("[Help] Error handling help request:", error))
              .finally(() => { isBusy = false; });
          } catch (error) {
            console.error("[Help] Error parsing help-request:", error);
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
      trackedPlayers.delete(participant.identity);
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
