/* global diriAPI */

const TARGET_SAMPLE_RATE = 16000;

let audioContext = null;
let mediaStream = null;
let source = null;
let processor = null;
let gainNode = null;
let isRecording = false;
let micReady = false;
let micInitPromise = null;
let resumeInterval = null;
let desiredRecording = false;
let operationGeneration = 0;
let recordingGeneration = 0;
let wakeWordEnabled = false;
let liveModeEnabled = false;
let shuttingDown = false;
let sustainedExternalAudioActive = false;
const playbackSpeechGate =
  typeof DaisyLivePlaybackSpeechGate !== "undefined"
    ? new DaisyLivePlaybackSpeechGate.LivePlaybackSpeechGate()
    : null;
let playbackSpeechGateActivity = false;

function logToMain(msg) {
  diriAPI.sendRendererLog("AUDIO_LOG: " + msg);
}

function downsampleBuffer(inputBuffer, inputSampleRate) {
  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    return inputBuffer;
  }

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const newLength = Math.round(inputBuffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < inputBuffer.length; i++) {
      accum += inputBuffer[i];
      count++;
    }

    result[offsetResult] = accum / count;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function floatTo16BitPCM(input) {
  const output = new ArrayBuffer(input.length * 2);
  const view = new DataView(output);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(output);
}

function uint8ToBase64(bytes) {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

let audioLogCounter = 0;

function releaseMic(reason) {
  const hadResources = Boolean(mediaStream || audioContext || source || processor || gainNode);
  if (hadResources) {
    logToMain("releaseMic: " + reason);
  }

  if (resumeInterval) {
    clearInterval(resumeInterval);
    resumeInterval = null;
  }

  if (processor) {
    processor.onaudioprocess = null;
    try { processor.disconnect(); } catch (_error) {}
  }
  if (source) {
    try { source.disconnect(); } catch (_error) {}
  }
  if (gainNode) {
    try { gainNode.disconnect(); } catch (_error) {}
  }
  if (mediaStream) {
    try {
      mediaStream.getTracks().forEach((track) => track.stop());
    } catch (_error) {}
  }

  const contextToClose = audioContext;
  audioContext = null;
  mediaStream = null;
  source = null;
  processor = null;
  gainNode = null;
  micReady = false;
  isRecording = false;

  if (contextToClose && contextToClose.state !== "closed") {
    contextToClose.close().catch((error) => {
      logToMain("releaseMic: failed to close AudioContext: " + error.message);
    });
  }
}

async function ensureMic() {
  if (micReady && audioContext && mediaStream) return true;
  if (micInitPromise) return micInitPromise;

  const initPromise = (async () => {
    let newStream = null;
    let newContext = null;
    let newSource = null;
    let newProcessor = null;
    let newGain = null;

    try {
      logToMain("ensureMic: requesting getUserMedia");
      newStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 48000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

      newContext = new AudioContext({ sampleRate: 48000 });
      newSource = newContext.createMediaStreamSource(newStream);

      const bufferSize = 4096;
      newProcessor = newContext.createScriptProcessor(bufferSize, 1, 1);
      newGain = newContext.createGain();
      newGain.gain.value = 0.0001;

      // Capture the context locally so a later cleanup cannot make this
      // callback dereference a different generation's global AudioContext.
      const inputSampleRate = newContext.sampleRate;
      newProcessor.onaudioprocess = (event) => {
        if (!isRecording && !wakeWordEnabled && !liveModeEnabled) return;
        const inputData = event.inputBuffer.getChannelData(0);

        audioLogCounter++;
        if (audioLogCounter % 100 === 0) {
          let max = 0;
          for (let i = 0; i < inputData.length; i++) {
            const abs = Math.abs(inputData[i]);
            if (abs > max) max = abs;
          }
          logToMain("audio flowing: " + audioLogCounter + " frames, maxLevel=" + max.toFixed(4));
        }

        const downsampled = downsampleBuffer(inputData, inputSampleRate);
        const gated = playbackSpeechGate
          ? playbackSpeechGate.process(downsampled)
          : { frames: [downsampled], activityChanged: null };
        if (gated.activityChanged !== null) {
          playbackSpeechGateActivity = Boolean(gated.activityChanged);
          diriAPI.sendLiveUserActivity(playbackSpeechGateActivity);
          logToMain(
            "external playback speech gate " +
              (playbackSpeechGateActivity ? "opened" : "closed") +
              " rms=" +
              Number(gated.rms || 0).toFixed(4) +
              " peak=" +
              Number(gated.peak || 0).toFixed(4) +
              " threshold=" +
              Number(gated.threshold || 0).toFixed(4),
          );
        }
        for (const frame of gated.frames) {
          const pcm = floatTo16BitPCM(frame);
          diriAPI.sendAudioData(
            uint8ToBase64(pcm),
            desiredRecording ? recordingGeneration : 0,
          );
        }
      };

      newSource.connect(newProcessor);
      newProcessor.connect(newGain);
      newGain.connect(newContext.destination);

      mediaStream = newStream;
      audioContext = newContext;
      source = newSource;
      processor = newProcessor;
      gainNode = newGain;
      micReady = true;
      logToMain("ensureMic: mic acquired and pipeline ready");

      if (newContext.state === "suspended") {
        await newContext.resume();
        logToMain("ensureMic: resumed suspended AudioContext");
      }

      if (resumeInterval) clearInterval(resumeInterval);
      resumeInterval = setInterval(() => {
        if (audioContext && audioContext.state === "suspended") {
          audioContext.resume().catch(() => {});
          logToMain("ensureMic: resumed suspended AudioContext (periodic check)");
        }
      }, 5000);

      if (shuttingDown || (!desiredRecording && !wakeWordEnabled && !liveModeEnabled)) {
        releaseMic(shuttingDown ? "window shutting down" : "pending start was cancelled");
        return false;
      }

      return true;
    } catch (error) {
      if (newProcessor) {
        newProcessor.onaudioprocess = null;
        try { newProcessor.disconnect(); } catch (_disconnectError) {}
      }
      if (newSource) {
        try { newSource.disconnect(); } catch (_disconnectError) {}
      }
      if (newGain) {
        try { newGain.disconnect(); } catch (_disconnectError) {}
      }
      if (newStream) {
        try { newStream.getTracks().forEach((track) => track.stop()); } catch (_stopError) {}
      }
      if (newContext && newContext.state !== "closed") {
        newContext.close().catch(() => {});
      }
      throw error;
    }
  })();

  micInitPromise = initPromise;
  try {
    return await initPromise;
  } finally {
    if (micInitPromise === initPromise) {
      micInitPromise = null;
    }
  }
}

async function setWakeWordEnabled(enabled) {
  wakeWordEnabled = enabled;
  logToMain("setWakeWordEnabled: enabled=" + enabled + " isRecording=" + isRecording);

  if (!enabled) {
    if (!desiredRecording && !isRecording && !liveModeEnabled) {
      releaseMic("wake-word monitoring disabled");
    }
    return;
  }

  if (!shuttingDown) {
    try {
      await ensureMic();
    } catch (error) {
      logToMain("setWakeWordEnabled: wake-word mic start failed: " + error.message);
      diriAPI.sendAudioError("无法访问麦克风：" + error.message);
    }
  }
}

async function setLiveModeEnabled(enabled) {
  liveModeEnabled = enabled;
  logToMain("setLiveModeEnabled: enabled=" + enabled);
  if (!enabled) {
    sustainedExternalAudioActive = false;
    if (!desiredRecording && !isRecording && !wakeWordEnabled) {
      releaseMic("Live mode disabled");
    }
    return;
  }

  if (!shuttingDown) {
    try {
      await ensureMic();
    } catch (error) {
      logToMain("setLiveModeEnabled: Live mic start failed: " + error.message);
      diriAPI.sendAudioError("无法访问麦克风：" + error.message);
    }
  }
}

async function setSustainedExternalAudioActive(active) {
  sustainedExternalAudioActive = Boolean(active);
  const gateState =
    playbackSpeechGate?.setExternalPlaybackActive(
      sustainedExternalAudioActive,
    );
  if (
    playbackSpeechGateActivity ||
    gateState?.activityChanged === false
  ) {
    playbackSpeechGateActivity = false;
    diriAPI.sendLiveUserActivity(false);
  }
  logToMain(
    "setSustainedExternalAudioActive: active=" +
      sustainedExternalAudioActive,
  );

  const track = mediaStream?.getAudioTracks?.()[0];
  if (!track || typeof track.applyConstraints !== "function") return;
  try {
    await track.applyConstraints({
      echoCancellation: true,
      noiseSuppression: true,
      // Keep native speech enhancement fully enabled during playback. Turning
      // AGC off here made the real user's voice quieter exactly when the local
      // speech gate needed to distinguish it from speaker leakage.
      autoGainControl: true,
    });
  } catch (error) {
    logToMain(
      "setSustainedExternalAudioActive: constraints unchanged: " +
        error.message,
    );
  }
}

async function startRecording(requestedGeneration = 0) {
  const mainGeneration = Number(requestedGeneration) || 0;
  if (
    mainGeneration > 0 &&
    recordingGeneration > 0 &&
    mainGeneration < recordingGeneration
  ) {
    logToMain("ignoring stale start generation=" + mainGeneration);
    return;
  }
  recordingGeneration = mainGeneration;
  const myGeneration = ++operationGeneration;
  desiredRecording = true;
  logToMain("startRecording: generation=" + myGeneration + " isRecording=" + isRecording + " micReady=" + micReady);

  try {
    const ready = await ensureMic();
    if (myGeneration !== operationGeneration || !desiredRecording || shuttingDown) return;
    if (!ready || !micReady) {
      throw new Error("麦克风初始化已取消");
    }

    isRecording = true;
    logToMain("startRecording: ready generation=" + myGeneration);
    diriAPI.sendAudioReady(mainGeneration);
  } catch (error) {
    if (myGeneration !== operationGeneration || !desiredRecording || shuttingDown) return;
    desiredRecording = false;
    isRecording = false;
    releaseMic("recording start failed");
    logToMain("startRecording FAILED: " + error.message);
    diriAPI.sendAudioError("无法访问麦克风：" + error.message, mainGeneration);
  }
}

function stopRecording(requestedGeneration = 0) {
  const mainGeneration = Number(requestedGeneration) || 0;
  if (
    mainGeneration > 0 &&
    recordingGeneration > 0 &&
    mainGeneration !== recordingGeneration
  ) {
    logToMain(
      "ignoring stale stop generation=" +
        mainGeneration +
        " active=" +
        recordingGeneration,
    );
    return;
  }
  const myGeneration = ++operationGeneration;
  logToMain("stopRecording: generation=" + myGeneration + " isRecording=" + isRecording + " micReady=" + micReady);
  desiredRecording = false;
  isRecording = false;

  if (!wakeWordEnabled && !liveModeEnabled) {
    releaseMic("recording stopped");
  }

  // Always acknowledge STOP, including cancellation during getUserMedia.
  // The in-flight initializer checks desiredRecording before publishing READY.
  const acknowledgedGeneration = mainGeneration || recordingGeneration;
  recordingGeneration = 0;
  diriAPI.sendAudioStopped(acknowledgedGeneration);
}

diriAPI.onStartRecording((generation) => {
  startRecording(generation);
});

diriAPI.onStopRecording((generation) => {
  stopRecording(generation);
});

diriAPI.onWakeWordEnabled((enabled) => {
  setWakeWordEnabled(Boolean(enabled));
});

diriAPI.onLiveCaptureEnabled((enabled) => {
  setLiveModeEnabled(Boolean(enabled));
});

diriAPI.onLiveExternalPlayback((active) => {
  setSustainedExternalAudioActive(Boolean(active));
});

window.onerror = (message, source, lineno, colno, error) => {
  diriAPI.sendRendererError(`audio.js error: ${message} at ${source}:${lineno}:${colno} ${error?.stack || ""}`);
};

window.onunhandledrejection = (event) => {
  diriAPI.sendRendererError(`audio.js unhandled rejection: ${event.reason}`);
};

window.addEventListener("beforeunload", () => {
  shuttingDown = true;
  operationGeneration++;
  desiredRecording = false;
  if (playbackSpeechGateActivity) {
    playbackSpeechGateActivity = false;
    diriAPI.sendLiveUserActivity(false);
  }
  releaseMic("window unloading");
});
