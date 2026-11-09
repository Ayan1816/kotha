import assert from "node:assert/strict";
import test from "node:test";
import { encodeWav, readVoiceDuration, VOICE_LIMIT_SECONDS, VOICE_TOO_LONG_MESSAGE, voiceExceedsLimit, wavDurationSeconds } from "./wav";

test("encodeWav writes 16 kHz 16-bit mono PCM", async () => {
  const samples = new Float32Array([0, 0.5, -1, 1]);
  const blob = encodeWav(samples, 16000);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(blob.type, "audio/wav");
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), "WAVE");
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), samples.length * 2);
  assert.equal(bytes.length, 44 + samples.length * 2);
  assert.equal(view.getInt16(44 + 4, true), -32768);
  const duration = wavDurationSeconds(bytes);
  assert.ok(duration != null && Math.abs(duration - samples.length / 16000) < 0.0001);
  assert.equal(readVoiceDuration(bytes).ok, true);
});

test("voice uploads longer than 30 seconds are rejected", () => {
  assert.equal(VOICE_LIMIT_SECONDS, 30);
  assert.equal(VOICE_TOO_LONG_MESSAGE, "Voice is limited to 30 seconds.");
  assert.equal(voiceExceedsLimit(30), false);
  assert.equal(voiceExceedsLimit(30.5), false);
  assert.equal(voiceExceedsLimit(30.51), true);
  const allowed = readVoiceDuration(pcmWav(30));
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.ok(Math.abs(allowed.duration - 30) < 0.001);
  assert.equal(readVoiceDuration(pcmWav(31)).ok, false);
  assert.equal(readVoiceDuration(new Uint8Array([1, 2, 3, 4])).ok, false);
  const clipped = pcmWav(30);
  const junk = new Uint8Array(clipped.length + 80);
  junk.set(clipped);
  assert.equal(readVoiceDuration(junk).ok, false);
});

function pcmWav(seconds: number): Uint8Array {
  const samples = Math.round(seconds * 16000);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}
