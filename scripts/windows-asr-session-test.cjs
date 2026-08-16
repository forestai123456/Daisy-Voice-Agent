const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const {
  AsrSession,
  AsrSessionState,
  __resetAsrNetworkBackoffForTest,
  getAsrNetworkRetryDelayMs,
} = require("../dist/main/asr/index.js");
const { config } = require("../dist/main/config/env.js");

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = false;
  }
  send(packet) { this.sent.push(packet); }
  open() { this.readyState = 1; this.emit("open"); }
  close() { this.closed = true; this.readyState = 3; }
  terminate() { this.closed = true; this.readyState = 3; }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const recorderSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "main", "audio", "recorder.ts"),
    "utf8",
  );
  const audioRendererSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "renderer", "audio.js"),
    "utf8",
  );
  assert.match(recorderSource, /Ignoring stale audio:ready generation=/);
  assert.match(recorderSource, /Number\(generation\) !== activeRecordingGeneration/);
  assert.match(audioRendererSource, /sendAudioReady\(mainGeneration\)/);
  assert.match(audioRendererSource, /sendAudioStopped\(acknowledgedGeneration\)/);
  config.asr.appId = "test-app";
  config.asr.accessToken = "test-token";
  config.asr.resourceId = "test-resource";
  __resetAsrNetworkBackoffForTest();

  const sockets = [];
  const factory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };

  const session = new AsrSession({ socketFactory: factory, connectTimeoutMs: 100 });
  session.start();
  session.start();
  assert.equal(sockets.length, 1, "CONNECTING must not create a second WebSocket");
  assert.equal(session.getState(), AsrSessionState.CONNECTING);
  session.feedPcm(Buffer.alloc(3200, 1));
  session.stop();
  assert.equal(session.getState(), AsrSessionState.STOPPING);
  assert.equal(session.getBufferedAudioBytes(), 3200, "pre-audio must survive until open/timeout");

  sockets[0].open();
  assert.equal(session.getState(), AsrSessionState.FINALIZING);
  assert.equal(session.getBufferedAudioBytes(), 0);
  assert.ok(sockets[0].sent.length >= 2, "configuration and final audio must both be sent");

  let finalCount = 0;
  session.on("final", () => { finalCount += 1; });
  sockets[0].emit("close");
  assert.equal(session.getState(), AsrSessionState.IDLE);
  assert.equal(finalCount, 1);

  const staleSession = new AsrSession({ socketFactory: factory, connectTimeoutMs: 100 });
  let staleCallbacks = 0;
  staleSession.on("final", () => { staleCallbacks += 1; });
  staleSession.on("error", () => { staleCallbacks += 1; });
  staleSession.start();
  const staleSocket = sockets.at(-1);
  staleSession.cancel();
  staleSocket.open();
  staleSocket.emit("close");
  assert.equal(staleCallbacks, 0, "cancelled generation callbacks must be ignored");
  assert.equal(staleSession.getState(), AsrSessionState.IDLE);

  __resetAsrNetworkBackoffForTest();
  const failing = new AsrSession({ socketFactory: factory, connectTimeoutMs: 100 });
  const networkErrors = [];
  failing.on("error", (message) => networkErrors.push(message));
  failing.start();
  sockets.at(-1).emit("error", new Error("offline"));
  assert.equal(networkErrors.length, 1);
  assert.ok(getAsrNetworkRetryDelayMs() > 0, "network failure must activate retry backoff");

  const countBeforeBlockedRetry = sockets.length;
  const blockedRetry = new AsrSession({ socketFactory: factory, connectTimeoutMs: 100 });
  const blockedErrors = [];
  blockedRetry.on("error", (message) => blockedErrors.push(message));
  blockedRetry.start();
  await delay(0);
  assert.equal(sockets.length, countBeforeBlockedRetry, "backoff must block immediate reconnect");
  assert.match(blockedErrors[0], /网络正在恢复/);

  __resetAsrNetworkBackoffForTest();
  const timingOut = new AsrSession({ socketFactory: factory, connectTimeoutMs: 10 });
  const timeoutErrors = [];
  timingOut.on("error", (message) => timeoutErrors.push(message));
  timingOut.start();
  timingOut.feedPcm(Buffer.alloc(6400, 2));
  timingOut.stop();
  await delay(30);
  assert.equal(timingOut.getState(), AsrSessionState.IDLE);
  assert.equal(timingOut.getBufferedAudioBytes(), 0);
  assert.match(timeoutErrors[0], /连接超时/);

  console.log(JSON.stringify({
    ok: true,
    singleConnectingSocket: true,
    stateMachine: "IDLE->CONNECTING->RECORDING/STOPPING->FINALIZING->IDLE",
    boundedPrebufferRetainedUntilTerminalGate: true,
    staleGenerationCallbacks: 0,
    staleRecorderAcksGuarded: true,
    networkBackoffEnabled: true,
    timeoutClearsPcm: true,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
