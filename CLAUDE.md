# CLAUDE.md - tech_world_bot

## Project Overview

Node.js bot service (Clawd) for Tech World. Uses LiveKit Agents framework to join rooms as a participant and respond to chat messages using Claude API.

## Build & Run

```bash
npm install
npm run dev              # local development with hot reload
npm run build            # compile TypeScript
npm start                # run compiled version
```

## Key Files

- `src/index.ts`: Main bot agent implementation
- `ecosystem.config.cjs`: PM2 process manager config (exponential backoff restarts)
- `package.json`: Node.js dependencies
- `.env`: Environment variables (see Configuration)

## Architecture

Uses `@livekit/agents` framework (v1.0+):
1. Registers as a worker with LiveKit Cloud
2. Receives job dispatch when a user joins a room (see Agent Dispatch below)
3. Joins room as participant `bot-claude`
4. Listens for `chat` topic data messages
5. Calls Claude API with conversation history
6. Publishes response on `chat-response` topic
7. On room disconnect, exits process so PM2 can restart it

### Agent Dispatch

LiveKit dispatches the bot via **token-based dispatch**: the Firebase Cloud Function (`retrieveLiveKitToken` in `tech_world_firebase_functions`) embeds a `RoomAgentDispatch` in every user's access token. When a user joins a room, LiveKit automatically dispatches the bot worker.

**Why not automatic dispatch?** LiveKit's default automatic dispatch only fires for *new* rooms. The `tech-world` room has a 5-minute `empty_timeout`, so if users sign out and back in quickly, the room persists and automatic dispatch never triggers.

**If the bot isn't being dispatched:**
1. Check `pm2 logs tech-world-bot` — look for `"registered worker"` (worker is connected) and `"received job request"` (dispatch received).
2. If worker registers but no dispatch, the `@livekit/agents` SDK version may be incompatible with LiveKit Cloud. Check `npm outdated @livekit/agents`.
3. Manual dispatch (emergency): use the LiveKit API `POST /twirp/livekit.AgentDispatchService/CreateDispatch {"room": "tech-world"}` (requires a signed JWT with admin grants).

### Disconnect Handling

The bot listens for `RoomEvent.Disconnected` and calls `process.exit(1)`. PM2 restarts the process with exponential backoff (`ecosystem.config.cjs`). On restart, the worker re-registers and waits for a new dispatch.

Message history is scoped per room instance (inside the `entry` function) to prevent context leaking across restarts.

## Data Channel Protocol

**Incoming (topic: `chat`):**
```json
{
  "id": "unique-message-id",
  "text": "user's message",
  "senderName": "Guest"
}
```

**Outgoing (topic: `chat-response`):**
```json
{
  "type": "chat-response",
  "id": "message-id-response",
  "messageId": "original-message-id",
  "text": "Clawd's response",
  "senderName": "Clawd",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Configuration

Create `.env`:

```sh
LIVEKIT_URL=wss://your-livekit-server.com
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
ANTHROPIC_API_KEY=your-anthropic-key
```

## Deployment

Runs on GCP Compute Engine (`tech-world-bot` instance) managed by PM2.

```bash
# SSH to server
gcloud compute ssh tech-world-bot --zone=us-central1-a --project=adventures-in-tech-world-0

# Check status
pm2 status

# View logs
pm2 logs tech-world-bot --lines 50

# Restart after update
cd ~/tech_world_bot && git pull && npm install && npm run build && pm2 restart tech-world-bot
```

## Notes

- Uses Claude Haiku 4.5 model (`claude-haiku-4-5-20251001`) for fast, cost-effective responses
- Keeps last 20 messages for conversation context
- System prompt configures "Clawd" personality as friendly coding tutor
- Challenge evaluations use a separate system prompt with structured `<!-- CHALLENGE_RESULT -->` tags for pass/fail parsing
