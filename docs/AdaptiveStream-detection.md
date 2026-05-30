# AdaptiveStream symptom detection

## Why this exists

Tech World's Flutter client renders LiveKit video tracks inside a Flame
canvas. Flame does not use LiveKit's `VideoTrackRenderer` widget, so the
client never signals "I want this video forwarded" to the SFU. When a
client connects with `adaptiveStream: true`, the SFU pauses forwarding
video to that subscriber, and the user silently sees no frames from any
other participant. This caused a real incident: a stale browser bundle
shipped with `adaptiveStream: true` and a meetup attendee couldn't see
anyone else's video.

The Flutter client must always set `adaptiveStream: false`. The CLAUDE.md
warning is documented but enforcement is hope-based.

## What the bot does

`src/adaptive-stream-detector.ts` attaches a heuristic detector to the
LiveKit `Room` when the bot joins. For each participant:

1. On `ParticipantConnected`, initialise tracking state.
2. On the first `TrackSubscribed` of `TrackKind.KIND_VIDEO`, open a
   `VideoStream` reader and arm a 30s timer.
3. The first `VideoFrameEvent` cancels the timer and we close the reader.
4. If the timer fires without a single frame arriving, log a structured
   warning containing the participant identity, sid, monitored track sids,
   and the detection window.

## What we ruled out

- **`ParticipantInfo.adaptiveStream`** — not exposed. `adaptiveStream` is
  carried in the client's `JoinRequest` and lives on `ConnectionSettings`,
  which the server holds but does not surface to other participants. Verified
  against `node_modules/@livekit/protocol/dist/index.d.ts` (only `adaptive_stream`
  field is on `ConnectionSettings`, not `ParticipantInfo`).
- **`pc.getStats()` byte counters** — `@livekit/rtc-node` does not expose a
  `getStats()` surface on `RemoteTrack`/`RemoteTrackPublication`. The
  underlying FFI bindings have stats messages but no public TS API.
- **Client-side hello message** — would require modifying the Flutter
  client, which the task scoped out (the whole point is to detect bad
  builds the bot didn't ship).
- **Tailing LiveKit server logs from the bot** — fragile and out of scope.

## Caveats — read these before trusting a warning

1. **The original incident was subscriber-side.** A client with
   `adaptiveStream: true` fails to *receive* video from others. The bot
   cannot directly observe what the SFU forwards to a third participant —
   only what it forwards to the bot. This detector catches the
   publisher-side manifestation of the same configuration: the SFU also
   throttles outgoing frame production when no demand is signalled,
   which means the bot (a subscriber) sees no frames. In practice the two
   correlate, but a client could in principle be `adaptiveStream: true`
   for subscriptions and still push frames as a publisher; we'd miss that.
2. **False positives.** Any participant whose camera fails to initialise,
   stays muted, or suffers severe packet loss will trip the warning.
   Treat the warning as a "look at this participant" prompt, not a verdict.
3. **The bot publishes no video.** We can't use the inverse signal
   ("nobody is consuming my track").

## Local verification

```bash
# Build the bot
npm run build

# Start it pointing at staging LiveKit
LIVEKIT_URL=wss://livekit.imagineering.cc \
LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
npm start

# In another terminal, join the same room with adaptiveStream=true:
lk room join --identity adaptive-true-test \
  --publish-demo l_room \
  --adaptive-stream

# Then with adaptiveStream=false (default):
lk room join --identity adaptive-false-test \
  --publish-demo l_room
```

The warning should fire ~30s after `adaptive-true-test` joins, and not
for `adaptive-false-test`.

## Future work

If we want to catch the genuine subscriber-side case, the only honest
solution is a small data-channel "hello" from the Flutter client carrying
its `livekit_client` version and `adaptiveStream` setting. That requires a
companion change in `tech_world` and was scoped out of this PR.
