/**
 * Audio pipeline bridging LiveKit room audio ↔ OpenAI Realtime API.
 *
 * Architecture:
 *   Remote participants' audio tracks (48 kHz)
 *       → AudioStream → AudioMixer (mixes all nearby speakers)
 *       → AudioResampler (48k → 24k)
 *       → OpenAI Realtime WebSocket (PCM16 @ 24 kHz)
 *
 *   OpenAI response audio (24 kHz)
 *       → AudioResampler (24k → 48k)
 *       → AudioSource → LocalAudioTrack → LiveKit room
 *
 * Proximity-based subscription is handled externally — callers add/remove
 * participants as they move in and out of range.
 */

import {
  AudioFrame,
  AudioMixer,
  AudioResampler,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  type LocalParticipant,
  type RemoteAudioTrack,
} from "@livekit/rtc-node";
import type { OpenAIRealtimeSession } from "./openai-realtime.js";

/** LiveKit's native sample rate. */
const LIVEKIT_RATE = 48000;
/** OpenAI Realtime API's expected sample rate. */
const OPENAI_RATE = 24000;
const CHANNELS = 1;

export class DreamfinderAudioPipeline {
  private mixer: AudioMixer;
  private inResampler: AudioResampler;   // 48k → 24k (to OpenAI)
  private outResampler: AudioResampler;  // 24k → 48k (from OpenAI)
  private audioSource: AudioSource;
  private activeStreams = new Map<string, AudioStream>();
  private inputLoopAbort: AbortController | null = null;
  private track: LocalAudioTrack | null = null;

  constructor(private openaiSession: OpenAIRealtimeSession) {
    this.mixer = new AudioMixer(LIVEKIT_RATE, CHANNELS);
    this.inResampler = new AudioResampler(LIVEKIT_RATE, OPENAI_RATE, CHANNELS);
    this.outResampler = new AudioResampler(OPENAI_RATE, LIVEKIT_RATE, CHANNELS);
    this.audioSource = new AudioSource(LIVEKIT_RATE, CHANNELS);

    // Wire OpenAI audio output → resampler → LiveKit audio source
    this.openaiSession.on("audio", (pcm16: Int16Array) => {
      this.handleOpenAIAudio(pcm16);
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create and publish DF's audio track to the LiveKit room.
   * Must be called after connecting to the room.
   */
  async publishTrack(localParticipant: LocalParticipant): Promise<LocalAudioTrack> {
    this.track = LocalAudioTrack.createAudioTrack("dreamfinder-voice", this.audioSource);
    await localParticipant.publishTrack(this.track, new TrackPublishOptions({
      source: TrackSource.SOURCE_MICROPHONE,
    }));
    console.log("Published Dreamfinder audio track to room");
    return this.track;
  }

  /** Start reading mixed audio from nearby participants and streaming to OpenAI. */
  async startInputLoop(): Promise<void> {
    this.inputLoopAbort = new AbortController();
    console.log("Audio input loop started (mixer → resample → OpenAI)");

    try {
      for await (const frame of this.mixer) {
        if (this.inputLoopAbort.signal.aborted) break;

        // Resample 48k → 24k and send to OpenAI
        const resampled = this.inResampler.push(frame);
        for (const rf of resampled) {
          this.openaiSession.sendAudio(rf.data);
        }
      }
    } catch (err) {
      if (!this.inputLoopAbort.signal.aborted) {
        console.error("Audio input loop error:", err);
      }
    }
  }

  /**
   * Add a remote participant's audio to the mix.
   * Called when a player enters proximity range (≤2 grid squares).
   */
  addParticipant(identity: string, track: RemoteAudioTrack): void {
    if (this.activeStreams.has(identity)) return;

    const stream = new AudioStream(track, LIVEKIT_RATE, CHANNELS);
    this.activeStreams.set(identity, stream);
    this.mixer.addStream(stream);
    console.log(`Audio: added ${identity} to mix (${this.activeStreams.size} active)`);
  }

  /**
   * Remove a participant's audio from the mix.
   * Called when a player exits proximity range (>2 grid squares).
   */
  removeParticipant(identity: string): void {
    const stream = this.activeStreams.get(identity);
    if (!stream) return;

    this.mixer.removeStream(stream);
    this.activeStreams.delete(identity);
    console.log(`Audio: removed ${identity} from mix (${this.activeStreams.size} active)`);
  }

  /** Stop all audio processing and clean up. */
  async close(): Promise<void> {
    this.inputLoopAbort?.abort();
    this.audioSource.clearQueue();
    await this.mixer.aclose();
    await this.audioSource.close();
    this.activeStreams.clear();
    console.log("Audio pipeline closed");
  }

  /** Clear the output queue — used when interrupting DF mid-speech. */
  clearOutput(): void {
    this.audioSource.clearQueue();
  }

  /** Returns identities of all participants currently in the audio mix. */
  get activeParticipants(): string[] {
    return Array.from(this.activeStreams.keys());
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Handle a PCM16 audio chunk from OpenAI's response.
   * Resample 24k → 48k and feed to the AudioSource for room playback.
   */
  private handleOpenAIAudio(pcm16: Int16Array): void {
    const frame = new AudioFrame(pcm16, OPENAI_RATE, CHANNELS, pcm16.length);
    const resampled = this.outResampler.push(frame);
    for (const rf of resampled) {
      this.audioSource.captureFrame(rf);
    }
  }
}
