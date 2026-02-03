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

const anthropic = new Anthropic();

// Message history for context (per room)
interface MessageContext {
  role: "user" | "assistant";
  content: string;
}
const messageHistory: MessageContext[] = [];
const MAX_HISTORY = 20; // Keep last 20 messages for context

async function handleChatMessage(
  ctx: JobContext,
  senderId: string,
  senderName: string,
  messageId: string,
  text: string
): Promise<void> {
  console.log(`[Chat] ${senderName} (${senderId}): ${text}`);

  // Add user message to history
  messageHistory.push({
    role: "user",
    content: `${senderName}: ${text}`,
  });

  // Trim history if too long
  while (messageHistory.length > MAX_HISTORY) {
    messageHistory.shift();
  }

  try {
    // Call Claude API
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-20250514",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: messageHistory,
    });

    // Extract text from response
    const responseText =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Add assistant response to history
    messageHistory.push({
      role: "assistant",
      content: responseText,
    });

    // Send response back via data channel
    const responsePayload = JSON.stringify({
      type: "chat-response",
      id: `${messageId}-response`,
      messageId: messageId, // ID of message being responded to
      text: responseText,
      senderName: "Clawd",
      timestamp: new Date().toISOString(),
    });

    const encoder = new TextEncoder();
    // Use ctx.agent (LocalParticipant) to publish data
    await ctx.agent?.publishData(encoder.encode(responsePayload), {
      topic: "chat-response",
      reliable: true,
    });

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

    // Listen for data messages
    room.on(
      RoomEvent.DataReceived,
      (
        payload: Uint8Array,
        participant?: RemoteParticipant,
        _kind?: DataPacketKind,
        topic?: string
      ) => {
        // Only process chat messages
        if (topic !== "chat") return;

        // Ignore messages from ourselves
        if (participant?.identity === "bot-claude") return;

        try {
          const decoder = new TextDecoder();
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

          // Handle asynchronously - don't await in event handler
          handleChatMessage(ctx, senderId, senderName, messageId, text).catch(
            (error) => console.error("[Bot] Error handling message:", error)
          );
        } catch (error) {
          console.error("[Bot] Error parsing message:", error);
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
      requestFunc: async (req) => {
        // Accept with custom identity "bot-claude"
        await req.accept("Clawd", "bot-claude");
      },
    })
  );
}
