# Tech World Bot (Clawd)

AI tutor bot for [Tech World](../tech_world) - a multiplayer game where players learn programming together.

## What it does

Clawd joins LiveKit rooms as a participant and responds to chat messages using Claude AI. It provides friendly, encouraging coding help to players.

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Run locally:**
   ```bash
   npm run dev
   ```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LIVEKIT_URL` | LiveKit server WebSocket URL |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude |

## How it works

1. Bot registers as a LiveKit Agent worker
2. When a room is created, LiveKit dispatches a job to the bot
3. Bot joins the room as participant `bot-claude`
4. Players send messages on the `chat` data channel topic
5. Bot calls Claude API and responds on `chat-response` topic
6. All players in the room see the response

## Tech Stack

- **Runtime:** Node.js 20+
- **Framework:** [@livekit/agents](https://docs.livekit.io/agents/)
- **AI:** Claude API via [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript)
- **Language:** TypeScript

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Run with hot reload (development) |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm start` | Run compiled version (production) |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Type check without emitting |

## Related

- [tech_world](../tech_world) - Flutter client app
- [tech_world_firebase_functions](../tech_world_firebase_functions) - Token generation

## License

MIT
