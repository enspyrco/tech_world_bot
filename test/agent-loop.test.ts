/**
 * Regression tests for the abortableSleep listener leak.
 *
 * The bug: `signal.addEventListener("abort", onAbort, { once: true })` only
 * auto-removes the listener WHEN ABORT FIRES. On the normal path — the timer
 * completes and nothing aborts — the listener stays attached to a signal that
 * lives as long as the room session. The wander loop calls abortableSleep from
 * nine sites, several inside `while` loops sleeping 1-2s, so a session accrues
 * thousands of listeners, each retaining a timer handle and a resolve closure.
 *
 * Controls come first here on purpose: a leak test that cannot observe a leak
 * would pass forever and prove nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

import { abortableSleep } from "../src/agent-loop.js";

const SLEEPS = 200;

/** A deliberately-leaky sleep: what the code did before the fix. */
function leakySleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => resolve(true), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve(false);
    }, { once: true });
  });
}

test("CONTROL (null arm): a fresh signal has no abort listeners", () => {
  const c = new AbortController();
  assert.equal(getEventListeners(c.signal, "abort").length, 0);
});

test("CONTROL (must-fail arm): the instrument CAN see a leak", async () => {
  const c = new AbortController();
  for (let i = 0; i < SLEEPS; i++) await leakySleep(0, c.signal);
  const leaked = getEventListeners(c.signal, "abort").length;
  assert.equal(
    leaked, SLEEPS,
    `the leaky implementation must accumulate ${SLEEPS} listeners, saw ${leaked}. ` +
    `If this fails, getEventListeners is not measuring what we think and every ` +
    `other assertion in this file is void.`
  );
});

test("abortableSleep removes its listener on the COMPLETION path", async () => {
  const c = new AbortController();
  for (let i = 0; i < SLEEPS; i++) {
    const completed = await abortableSleep(0, c.signal);
    assert.equal(completed, true, "an un-aborted sleep must resolve true");
  }
  const remaining = getEventListeners(c.signal, "abort").length;
  assert.equal(
    remaining, 0,
    `expected 0 listeners after ${SLEEPS} completed sleeps, found ${remaining}`
  );
});

test("abortableSleep still resolves false when aborted (capability preserved)", async () => {
  const c = new AbortController();
  const pending = abortableSleep(60_000, c.signal);
  c.abort();
  assert.equal(await pending, false, "an aborted sleep must resolve false");
  assert.equal(getEventListeners(c.signal, "abort").length, 0);
});

test("abortableSleep returns false immediately on an already-aborted signal", async () => {
  const c = new AbortController();
  c.abort();
  assert.equal(await abortableSleep(60_000, c.signal), false);
  assert.equal(getEventListeners(c.signal, "abort").length, 0);
});
