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
- `package.json`: Node.js dependencies
- `.env`: Environment variables (see Configuration)

## Architecture

Uses `@livekit/agents` framework:
1. Registers as a LiveKit worker
2. Receives job when room is created
3. Joins room as participant `bot-claude`
4. Listens for `chat` topic data messages
5. Calls Claude API with conversation history
6. Publishes response on `chat-response` topic

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

- Uses Claude claude-sonnet-4-20250514 model
- Keeps last 20 messages for conversation context
- System prompt configures "Clawd" personality as friendly coding tutor
