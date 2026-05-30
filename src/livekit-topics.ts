/**
 * LiveKit data-channel topic constants.
 *
 * Mirrors a subset of the Flutter client's `LiveKitTopic` enum
 * (`lib/livekit/livekit_topic.dart`). Wire strings MUST stay byte-for-byte
 * identical across the two repos — there's no CI gate yet (see TODO in
 * tech_world/CLAUDE.md "Cross-repo topic drift test"), so changes must be
 * coordinated by hand.
 *
 * Only topics the bot actually receives or publishes belong here.
 */
export const LiveKitTopics = {
  /**
   * One-shot client self-report sent immediately after a successful connect.
   *
   * Payload (schemaVersion 1):
   *   {
   *     schemaVersion: 1,
   *     clientSdk: "flutter",
   *     clientSdkVersion: string,
   *     buildSha: string,
   *     appVersion: string,
   *     adaptiveStream: boolean,   // true = known-bad for Tech World
   *     dynacast: boolean,
   *     platform: string,          // "web" | "macos" | "ios" | ...
   *     userAgent: string | null,  // web only
   *   }
   *
   * Wire string is snake_case (deliberate — agent-inbound channel naming).
   */
  AGENT_HELLO: "agent_hello",
} as const;

export type LiveKitTopic = (typeof LiveKitTopics)[keyof typeof LiveKitTopics];
