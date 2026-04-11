/**
 * OpenAI Realtime API WebSocket client for server-side use.
 *
 * Manages a persistent WebSocket connection to gpt-4o-realtime-preview.
 * Streams PCM16 audio in/out and handles tool calls.
 *
 * Unlike the browser client (which uses ephemeral tokens + subprotocol auth),
 * the server authenticates directly via Authorization header.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";

const REALTIME_MODEL = "gpt-4o-realtime-preview-2025-06-03";
const SAMPLE_RATE = 24000;

export interface RealtimeToolDef {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OpenAIRealtimeOptions {
  apiKey: string;
  model?: string;
  systemPrompt: string;
  tools: RealtimeToolDef[];
  voice?: string;
  silenceDurationMs?: number;
}

export interface OpenAIRealtimeEvents {
  /** PCM16 audio chunk from the model's response. */
  audio: [pcm16: Int16Array];
  /** Transcript of the model's spoken response, with optional mood tag. */
  transcript: [text: string, mood: string | null];
  /** Tool/function call request from the model. */
  tool_call: [name: string, args: string, callId: string];
  /** Response generation complete. */
  done: [];
  /** Session connected and configured. */
  ready: [];
  /** Connection closed or errored. */
  error: [error: Error];
}

export class OpenAIRealtimeSession extends EventEmitter {
  private ws: WebSocket | null = null;
  private opts: Required<
    Pick<OpenAIRealtimeOptions, "apiKey" | "model" | "systemPrompt" | "tools" | "voice" | "silenceDurationMs">
  >;

  constructor(opts: OpenAIRealtimeOptions) {
    super();
    this.opts = {
      apiKey: opts.apiKey,
      model: opts.model ?? REALTIME_MODEL,
      systemPrompt: opts.systemPrompt,
      tools: opts.tools,
      voice: opts.voice ?? "ash",
      silenceDurationMs: opts.silenceDurationMs ?? 1200,
    };
  }

  /** Connect to the OpenAI Realtime API. Resolves when session is configured. */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?model=${this.opts.model}`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws.on("open", () => {
        this.configureSession();
        this.emit("ready");
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          console.error("Failed to parse Realtime message:", err);
        }
      });

      this.ws.on("close", () => {
        this.ws = null;
      });

      this.ws.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });
    });
  }

  /** Stream a chunk of PCM16 audio to the model. */
  sendAudio(pcm16: Int16Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Convert Int16Array to base64
    const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    const base64 = Buffer.from(bytes).toString("base64");

    this.send("input_audio_buffer.append", { audio: base64 });
  }

  /** Send a tool/function call result back to the model. */
  sendToolResult(callId: string, output: string): void {
    this.send("conversation.item.create", {
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    });
    this.send("response.create", {});
  }

  /** Send a text message (e.g. greeting prompt). */
  sendText(text: string): void {
    this.send("conversation.item.create", {
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.send("response.create", {});
  }

  /** Cancel the current in-flight response. */
  cancelResponse(): void {
    this.send("response.cancel", {});
  }

  /** Close the WebSocket connection. */
  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private configureSession(): void {
    this.send("session.update", {
      session: {
        instructions: this.opts.systemPrompt,
        tools: this.opts.tools,
        tool_choice: "auto",
        voice: this.opts.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          silence_duration_ms: this.opts.silenceDurationMs,
        },
      },
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "response.output_audio.delta": {
        const delta = msg.delta as string;
        if (!delta) break;
        const bytes = Buffer.from(delta, "base64");
        const pcm16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
        this.emit("audio", pcm16);
        break;
      }

      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done": {
        const text = (msg.transcript as string) ?? "";
        const { mood, cleanText } = parseMoodTag(text);
        this.emit("transcript", cleanText, mood);
        break;
      }

      case "response.function_call_arguments.done": {
        const name = msg.name as string;
        const args = msg.arguments as string;
        const callId = msg.call_id as string;
        this.emit("tool_call", name, args, callId);
        break;
      }

      case "response.done":
        this.emit("done");
        break;

      case "error": {
        const error = msg.error as { message?: string } | undefined;
        console.error("OpenAI Realtime error:", error?.message ?? msg);
        this.emit("error", new Error(error?.message ?? "Unknown Realtime error"));
        break;
      }
    }
  }

  private send(type: string, data: Record<string, unknown> = {}): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...data }));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract [mood:X] prefix from transcript text. */
function parseMoodTag(text: string): { mood: string | null; cleanText: string } {
  const match = text.match(/^\[mood:(\w+)\]\s*/);
  if (match) return { mood: match[1], cleanText: text.slice(match[0].length) };
  return { mood: null, cleanText: text };
}
