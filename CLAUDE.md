# CLAUDE.md - tech_world_bot

## Project Overview

Node.js bot service for Tech World. Runs two AI bot personalities — **Clawd** (friendly coding tutor) and **Gremlin** (chaotic hype creature) — using the LiveKit Agents framework. Each bot joins rooms as a participant and interacts via Claude API.

## Build & Run

```bash
npm install
npm run dev -- --bot=clawd    # local dev (or --bot=gremlin)
npm run build                  # compile TypeScript
npm start                      # run compiled version
npm run lint                   # ESLint
```

## Key Files

- `src/index.ts`: Main bot agent implementation
- `src/bot-config.ts`: Per-bot configuration (identity, prompts, behavior)
- `src/prompts/clawd.ts`: Clawd personality prompts
- `src/prompts/gremlin.ts`: Gremlin personality prompts
- `src/agent-loop.ts`: Autonomous wandering and stuck detection
- `src/server.ts`: HTTP health server for Cloud Run
- `Dockerfile`: Multi-stage build for Cloud Run deployment
- `.env`: Environment variables (see Configuration)

## Architecture

Uses `@livekit/agents` framework (v1.0+):
1. Registers as a named worker with LiveKit Cloud (`agentName` from config)
2. Receives job dispatch when a user joins a room (see Agent Dispatch below)
3. Joins room as participant (e.g., `bot-claude` or `bot-gremlin`)
4. Listens for `chat`, `help-request`, `map-info`, and `terminal-activity` data messages
5. Calls Claude API with conversation history
6. Publishes responses on `chat-response` and `help-response` topics
7. Autonomously wanders the game world using A* pathfinding
8. Proactively approaches stuck players to offer help

### Dual-Bot Configuration

Bot behavior is driven by `BotConfig` in `src/bot-config.ts`:
- **Clawd** (`agentName: "clawd"`): Responds to all messages, evaluates challenges, gives hints
- **Gremlin** (`agentName: "gremlin"`): Only responds when addressed by name, no challenge eval or hints

Bot selection: `--bot=<name>` CLI arg → `BOT_NAME` env var → defaults to `clawd`.

### Agent Dispatch

LiveKit dispatches bots via **token-based dispatch**: the Firebase Cloud Function (`retrieveLiveKitToken`) embeds `RoomAgentDispatch` entries for both `clawd` and `gremlin` in every user's access token.

**If a bot isn't being dispatched:**
1. Check Cloud Run logs — look for `"registered worker"` and `"received job request"`.
2. If worker registers but no dispatch, check `@livekit/agents` SDK compatibility.
3. Manual dispatch (emergency): `lk dispatch create --agent-name clawd --room <room-name>`

### Deployment

Deployed as two Cloud Run services (one per bot) with scale-to-zero:

```bash
# Build and push image
gcloud builds submit --tag gcr.io/adventures-in-tech-world-0/tech-world-bot

# Deploy (same image, different BOT_NAME)
gcloud run deploy clawd-bot --image gcr.io/..../tech-world-bot \
  --set-env-vars "BOT_NAME=clawd" --min-instances 0 --max-instances 1 \
  --no-cpu-throttling --timeout 3600

gcloud run deploy gremlin-bot --image gcr.io/..../tech-world-bot \
  --set-env-vars "BOT_NAME=gremlin" --min-instances 0 --max-instances 1 \
  --no-cpu-throttling --timeout 3600
```

The Cloud Function wakes both services on user join. `--no-cpu-throttling` keeps the WebSocket and wandering loop alive between HTTP requests.

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
  "id": "message-id-botname-response",
  "messageId": "original-message-id",
  "text": "Bot's response",
  "senderName": "Clawd",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

Response IDs include the bot's `agentName` to prevent deduplication when both bots respond to the same message.

## Configuration

Create `.env`:

```sh
LIVEKIT_URL=wss://your-livekit-server.com
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
ANTHROPIC_API_KEY=your-anthropic-key
```

## Notes

- Uses Claude Haiku 4.5 model (`claude-haiku-4-5-20251001`) for fast, cost-effective responses
- Keeps last 20 messages for conversation context
- Challenge evaluations use structured `<!-- CHALLENGE_RESULT -->` tags for pass/fail parsing
- Requires `node:20` (not slim) — `@livekit/rtc-node` native binary needs system libraries
