/** 16-bit mono PCM WAV. No extra dependencies. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] || 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Blob([bytes], { type: "audio/wav" });
}

export async function recordedBlobToWav(blob: Blob): Promise<{ wav: Blob; duration: number }> {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("This browser cannot decode the recording.");
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const duration = decoded.duration;
    const frames = Math.max(1, Math.ceil(duration * 16000));
    const offline = new OfflineAudioContext(1, frames, 16000);
    const mono = offline.createBuffer(1, decoded.length, decoded.sampleRate);
    const target = mono.getChannelData(0);
    const channels = decoded.numberOfChannels;
    for (let index = 0; index < decoded.length; index += 1) {
      let sum = 0;
      for (let channel = 0; channel < channels; channel += 1) sum += decoded.getChannelData(channel)[index] || 0;
      target[index] = sum / channels;
    }
    const source = offline.createBufferSource();
    source.buffer = mono;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    return { wav: encodeWav(rendered.getChannelData(0), 16000), duration };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}

/** Recordings stop at 30s. Half a second of encode slack keeps a full clip. */
export const VOICE_LIMIT_SECONDS = 30;
export const VOICE_TOO_LONG_MESSAGE = "Voice is limited to 30 seconds.";

export function voiceExceedsLimit(durationSeconds: number): boolean {
  return !Number.isFinite(durationSeconds) || durationSeconds < 0 || durationSeconds > VOICE_LIMIT_SECONDS + 0.5;
}

export function readVoiceDuration(bytes: Uint8Array): { ok: true; duration: number } | { ok: false } {
  const duration = wavDurationSeconds(bytes);
  if (duration == null || voiceExceedsLimit(duration)) return { ok: false };
  return { ok: true, duration };
}

/** PCM WAV duration from the fmt and data chunks. Extra trailing audio is rejected. */
export function wavDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return null;
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataBytes = -1;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = readU32(bytes, offset + 4);
    const start = offset + 8;
    if (!Number.isFinite(size) || size < 0 || start > bytes.length || size > bytes.length - start) return null;
    if (id === "fmt " && size >= 16) {
      channels = readU16(bytes, start + 2);
      sampleRate = readU32(bytes, start + 4);
      bits = readU16(bytes, start + 14);
    } else if (id === "data") {
      dataBytes = size;
      if (bytes.length - (start + size) > 1) return null;
      break;
    }
    offset = start + size + (size % 2);
  }
  if (sampleRate <= 0 || channels <= 0 || bits <= 0 || bits % 8 !== 0 || dataBytes < 0) return null;
  const frame = channels * (bits / 8);
  if (frame <= 0) return null;
  return dataBytes / (sampleRate * frame);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[offset + index] || 0);
  return text;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] || 0) | ((bytes[offset + 1] || 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] || 0) |
    ((bytes[offset + 1] || 0) << 8) |
    ((bytes[offset + 2] || 0) << 16) |
    ((bytes[offset + 3] || 0) << 24)
  ) >>> 0;
}
