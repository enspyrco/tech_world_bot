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
- `src/server.ts`: HTTP health server (used by the Docker healthcheck on OCI)
- `Dockerfile`: Multi-stage Node 20 build — runs in Docker on OCI
- `.env`: Environment variables for local dev (see Configuration). Production secrets live in `imagineering-infra/tech-world-bots/secrets.yaml` (sops-encrypted).

## Architecture

Uses `@livekit/agents` framework (v1.0+):
1. Registers as a named worker with the self-hosted LiveKit (`wss://livekit.imagineering.cc`, also on OCI; `agentName` from config)
2. Receives job dispatch when a user joins a room (see Agent Dispatch below)
3. Joins room as participant (e.g., `bot-claude` or `bot-gremlin`)
4. Listens for `chat`, `help-request`, `map-info`, `terminal-activity`, and `oracle-request` data messages
5. Calls Claude API with conversation history
6. Publishes responses on `chat-response`, `help-response`, and `oracle-response` topics
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
1. Check container logs on OCI: `ssh nick@149.118.69.221 docker logs --tail 100 tw-clawd` — look for `"registered worker"` and `"received job request"`.
2. Confirm the container is actually up: `ssh nick@149.118.69.221 docker ps | grep tw-`. Containers: `tw-clawd`, `tw-gremlin`, and (when active) `tw-dreamfinder`.
3. If worker registers but no dispatch, check `@livekit/agents` SDK compatibility.
4. Manual dispatch (emergency): `lk dispatch create --agent-name clawd --room <room-name>`

### Deployment

**Production runs on OCI** (`149.118.69.221`) as Docker containers — `tw-clawd`, `tw-gremlin`, and (when active) `tw-dreamfinder`. Cloud Run was tried briefly but is no longer used; ignore any stale references to `gcloud builds submit` / `gcloud run deploy`.

Deploy via the `imagineering-infra` script:

```bash
cd ~/git/orgs/imagineering/imagineering-infra
./scripts/deploy-to.sh 149.118.69.221 tech-world-bots
```

The script: decrypts `tech-world-bots/secrets.yaml` via sops → generates `.env` on the VPS → rsyncs source + `docker-compose.yml` → builds the Docker image on the VPS → restarts the containers.

The bots are long-running workers that hold a WebSocket to LiveKit; there is no scale-to-zero. Containers auto-restart via Docker `restart: unless-stopped`.

**Verifying a deploy:**
1. `ssh nick@149.118.69.221 docker ps | grep tw-` — confirm containers running
2. `ssh nick@149.118.69.221 docker logs --tail 50 tw-clawd` — look for `"registered worker"`
3. Trigger a dispatch (user joins room) and watch for `"received job request"`

**Production safety:** the imagineering-infra `CLAUDE.md` warns against repeated/rapid commands on the VPS — be deliberate.

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
