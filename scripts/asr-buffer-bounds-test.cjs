const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src", "main", "asr", "index.ts"), "utf8");
const {
  AsrSession,
  MAX_PENDING_AUDIO_BYTES,
  __resetAsrNetworkBackoffForTest,
} = require("../dist/main/asr/index.js");

__resetAsrNetworkBackoffForTest();
assert.equal(MAX_PENDING_AUDIO_BYTES, 16000 * 2 * 20);
assert.doesNotMatch(
  source,
  /audioBuffer\s*=\s*Buffer\.concat\(\[this\.audioBuffer/,
  "ASR must not rebuild the complete recording on every PCM chunk",
);
assert.match(source, /private audioChunks: Buffer\[\] = \[\]/);
assert.match(source, /ASR 音频缓存已达到 20 秒上限/);

const offline = new AsrSession();
const offlineErrors = [];
offline.on("error", (message) => offlineErrors.push(message));
offline.sessionActive = true;
const pcmChunk = Buffer.alloc(4096, 1);
for (let fed = 0; fed < MAX_PENDING_AUDIO_BYTES * 20; fed += pcmChunk.length) {
  offline.feedPcm(pcmChunk);
}
assert.equal(offlineErrors.length, 1, "an overflowing offline session must terminate once");
assert.match(offlineErrors[0], /20 秒上限/);
assert.equal(offline.getBufferedAudioBytes(), 0, "overflow must immediately release queued PCM");
assert.equal(offline.sessionActive, false);
assert.equal(offline.audioChunks.length, 0);

const cancelledBeforeConnect = new AsrSession();
cancelledBeforeConnect.sessionActive = true;
cancelledBeforeConnect.feedPcm(Buffer.alloc(32000, 2));
assert.equal(cancelledBeforeConnect.getBufferedAudioBytes(), 32000);
cancelledBeforeConnect.cancel();
assert.equal(cancelledBeforeConnect.getBufferedAudioBytes(), 0, "cancel must clear pre-connect PCM");

const streaming = new AsrSession();
streaming.on("error", (message) => assert.fail(message));
const sentPackets = [];
streaming.sessionActive = true;
streaming.ready = true;
streaming.socket = {
  readyState: 1,
  bufferedAmount: 0,
  send(packet) { sentPackets.push(packet); },
  removeAllListeners() {},
  on() {},
  close() {},
  terminate() {},
};
for (let index = 0; index < 5000; index += 1) {
  streaming.feedPcm(Buffer.alloc(640, index % 255));
  assert.ok(streaming.getBufferedAudioBytes() < 3200, "connected PCM must stream in 100ms blocks");
}
assert.ok(sentPackets.length >= 1000, "streaming session should continuously send bounded packets");
streaming.cancel();
assert.equal(streaming.getBufferedAudioBytes(), 0);

console.log(JSON.stringify({
  ok: true,
  repeatedBufferConcatRemoved: true,
  pendingAudioLimitBytes: MAX_PENDING_AUDIO_BYTES,
  cancelAndErrorClearPcm: true,
  connectedAudioStreamsInBoundedSegments: true,
}));
