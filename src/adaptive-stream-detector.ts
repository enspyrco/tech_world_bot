// SPDX-License-Identifier: Apache-2.0
//
// Heuristic detector for the `adaptiveStream: true` symptom on Tech World
// participants. See docs/AdaptiveStream-detection.md for the rationale and
// known limitations.
//
// Background
// ----------
// Tech World's Flutter client renders LiveKit video feeds inside a Flame
// canvas (no `VideoTrackRenderer` widget). Flame doesn't signal demand to
// the SFU, so when a client connects with `adaptiveStream: true`, the SFU
// pauses forwarding video tracks to that subscriber — the user appears to
// see other players' bubbles but no frames ever arrive. We had a real
// incident where a stale browser bundle shipped `adaptiveStream: true` and
// the user silently couldn't see anyone.
//
// What this detector does
// -----------------------
// `adaptiveStream` is set in the client's JoinRequest and is NOT exposed
// on `ParticipantInfo` (verified against @livekit/protocol's `.d.ts` — the
// field only appears on `ConnectionSettings`, which the server holds but
// doesn't surface to other participants). Modifying the Flutter client to
// echo its `adaptiveStream` value over a data channel was ruled out.
//
// Instead, this is a publisher-side heuristic: after a participant connects,
// we wait for them to publish a video track and subscribe to it. If 30s
// elapse from the first published+unmuted video track without a single
// frame arriving at the bot, we log a structured warning. The most common
// cause of this signal in practice is `adaptiveStream: true` on the
// publisher side (the SFU pauses encoding when no subscribers demand it,
// and the publisher then doesn't push frames either).
//
// Caveats
// -------
// 1. The original incident was *subscriber-side* (her client couldn't
//    receive video). The bot cannot directly observe what the SFU forwards
//    to other participants. This detector catches the publisher-side
//    symptom of the same configuration bug, which is a strict subset.
// 2. False positives possible: a participant whose camera fails to
//    initialise, a muted track that stays muted, or severe packet loss
//    will also trip this warning.
// 3. The bot itself doesn't publish video, so we can't use the inverse
//    (zero subscribers consuming a bot-published track).

import { RoomEvent, TrackKind } from "@livekit/rtc-node";
import type {
  Room,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteVideoTrack,
} from "@livekit/rtc-node";
import { VideoStream } from "@livekit/rtc-node";

/** Window after participant connect within which we expect to see frames. */
export const DEFAULT_DETECTION_WINDOW_MS = 30_000;

/**
 * Per-participant state tracked by the detector. Exposed for tests.
 */
export interface ParticipantState {
  identity: string;
  /** Timer fires `DEFAULT_DETECTION_WINDOW_MS` after first video subscribe. */
  timer?: NodeJS.Timeout;
  /** Set to true on the first VideoFrameEvent from any video track. */
  receivedAnyFrame: boolean;
  /** Track SIDs we've started a VideoStream reader for. */
  monitoredTrackSids: Set<string>;
}

export interface DetectorOptions {
  windowMs?: number;
  /** Override the warn logger (used by tests). Defaults to `console.warn`. */
  warn?: (message: string, fields: Record<string, unknown>) => void;
  /** Override the info logger (used by tests). Defaults to `console.log`. */
  info?: (message: string) => void;
}

/**
 * Attaches an adaptiveStream-symptom detector to the given `Room`. Returns
 * a disposer that detaches all listeners and clears outstanding timers.
 *
 * Lifecycle:
 *   - ParticipantConnected      -> start tracking state
 *   - TrackSubscribed (video)   -> start frame reader + start/refresh timer
 *   - first VideoFrameEvent     -> mark `receivedAnyFrame`, cancel timer
 *   - timer fires w/o frame     -> log structured warning
 *   - ParticipantDisconnected   -> clean up
 */
export function attachAdaptiveStreamDetector(
  room: Room,
  options: DetectorOptions = {}
): () => void {
  const windowMs = options.windowMs ?? DEFAULT_DETECTION_WINDOW_MS;
  const warn = options.warn ?? defaultWarn;
  const info = options.info ?? ((m: string) => console.log(m));

  const states = new Map<string, ParticipantState>();
  const streamReaders = new Map<string, AbortController>(); // keyed by trackSid

  const onParticipantConnected = (participant: RemoteParticipant) => {
    states.set(participant.identity, {
      identity: participant.identity,
      receivedAnyFrame: false,
      monitoredTrackSids: new Set(),
    });
  };

  const onParticipantDisconnected = (participant: RemoteParticipant) => {
    const state = states.get(participant.identity);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    for (const sid of state.monitoredTrackSids) {
      streamReaders.get(sid)?.abort();
      streamReaders.delete(sid);
    }
    states.delete(participant.identity);
  };

  const onTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ) => {
    if (publication.kind !== TrackKind.KIND_VIDEO) return;
    const state = states.get(participant.identity);
    if (!state) return;

    const sid = publication.sid;
    if (!sid || state.monitoredTrackSids.has(sid)) return;
    state.monitoredTrackSids.add(sid);

    // Start a VideoStream reader. The first frame flips
    // `receivedAnyFrame` and cancels the warning timer.
    const controller = new AbortController();
    streamReaders.set(sid, controller);
    void readFramesUntilFirstOrAbort(
      track as RemoteVideoTrack,
      controller,
      () => {
        state.receivedAnyFrame = true;
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
        info(
          `[AdaptiveStream] First video frame received from ${participant.identity} ` +
            `(track ${sid}) — subscriber path healthy.`
        );
      }
    );

    // Arm the timer on the FIRST video track only. Late-added tracks reuse
    // the existing timer; if any track delivered a frame already, no timer.
    if (!state.timer && !state.receivedAnyFrame) {
      state.timer = setTimeout(() => {
        state.timer = undefined;
        if (state.receivedAnyFrame) return;
        warn(
          "AdaptiveStream symptom: participant published video but bot received zero " +
            "frames within the detection window. Most likely cause: client connected " +
            "with `adaptiveStream: true`. Tech World uses Flame canvas which does not " +
            "signal demand to the SFU, so adaptiveStream causes silent video loss.",
          {
            event: "adaptive_stream_warning",
            participantIdentity: participant.identity,
            participantSid: participant.sid,
            windowMs,
            monitoredTrackSids: Array.from(state.monitoredTrackSids),
          }
        );
      }, windowMs);
    }
  };

  room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
  room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
  room.on(RoomEvent.TrackSubscribed, onTrackSubscribed);

  return () => {
    room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
    room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
    for (const state of states.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    for (const controller of streamReaders.values()) {
      controller.abort();
    }
    states.clear();
    streamReaders.clear();
  };
}

/**
 * Reads the VideoStream until the first frame arrives or the controller
 * aborts. We only need ONE frame to know forwarding is alive; after that
 * we cancel the reader to avoid burning CPU on frame decoding the bot
 * doesn't use.
 */
async function readFramesUntilFirstOrAbort(
  track: RemoteVideoTrack,
  controller: AbortController,
  onFirstFrame: () => void
): Promise<void> {
  let stream: VideoStream;
  try {
    stream = new VideoStream(track);
  } catch (err) {
    // If we can't open the stream, give up silently — the timer will still
    // fire and produce a (slightly noisier) warning.
    console.warn("[AdaptiveStream] Failed to open VideoStream for frame probe:", err);
    return;
  }

  const reader = stream.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const { done, value } = await reader.read();
    if (!done && value && !controller.signal.aborted) {
      onFirstFrame();
    }
  } catch {
    // Stream closed / track ended — nothing to do.
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
  }
}

function defaultWarn(message: string, fields: Record<string, unknown>): void {
  // Structured-warning shape compatible with stdout-as-log pipelines.
  console.warn(`[AdaptiveStream] ${message}`, JSON.stringify(fields));
}
