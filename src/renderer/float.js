/* global diriAPI */

// ── 极光配方配置 ──
const palettes = {
  idle: {
    main: "#6C6EF5",
    mid: "#30268a",
    dark: "#140c38",
    deepDark: "#0d0728",
    highlight: "#C5C1FF",
    glow: "rgba(108, 110, 245, 0.45)",
    filaments: ["#6C6EF5", "#EC4899", "#8B5CF6"],
    blobs: ["#6C6EF5", "#8B5CF6", "#EC4899"],
    linearGradient: {
      topLeft: "rgba(108, 110, 245, 0.85)",
      middle: "rgba(139, 92, 246, 0.50)",
      bottomRight: "rgba(236, 72, 153, 0.20)"
    }
  },
  listening: {
    main: "#00A2FF",
    mid: "#184594",
    dark: "#0a1738",
    deepDark: "#02071a",
    highlight: "#B8DBFF",
    glow: "rgba(0, 162, 255, 0.55)",
    filaments: ["#00A2FF", "#38BDF8", "#7DD3FC"],
    blobs: ["#00A2FF", "#38BDF8", "#7DD3FC"],
    linearGradient: {
      topLeft: "rgba(0, 162, 255, 0.85)",
      middle: "rgba(56, 189, 248, 0.50)",
      bottomRight: "rgba(125, 211, 252, 0.20)"
    }
  },
  thinking: {
    main: "#FF8033",
    mid: "#9e4313",
    dark: "#3d1404",
    deepDark: "#1a0600",
    highlight: "#FFE0C0",
    glow: "rgba(255, 128, 51, 0.55)",
    filaments: ["#FF8033", "#FF9955", "#FFBB77"],
    blobs: ["#FF8033", "#FF9955", "#FFBB77"],
    linearGradient: {
      topLeft: "rgba(255, 128, 51, 0.90)",
      middle: "rgba(255, 128, 51, 0.60)",
      bottomRight: "rgba(255, 128, 51, 0.22)"
    }
  },
  speaking: {
    main: "#0FC882",
    mid: "#0e5a37",
    dark: "#032112",
    deepDark: "#010d06",
    highlight: "#B0FFD4",
    glow: "rgba(15, 200, 130, 0.55)",
    filaments: ["#0FC882", "#19D291", "#37EBB4"],
    blobs: ["#0FC882", "#19D291", "#37EBB4"],
    linearGradient: {
      topLeft: "rgba(15, 200, 130, 0.82)",
      middle: "rgba(25, 210, 145, 0.48)",
      bottomRight: "rgba(55, 235, 180, 0.18)"
    }
  },
  error: {
    main: "#F56060",
    mid: "#8a1b1b",
    dark: "#380606",
    deepDark: "#170101",
    highlight: "#FFC0C0",
    glow: "rgba(245, 96, 96, 0.55)",
    filaments: ["#EF4444", "#FBBF24", "#EC4899"],
    blobs: ["#F56060", "#DC2626", "#8B5CF6"],
    linearGradient: {
      topLeft: "rgba(245, 96, 96, 0.85)",
      middle: "rgba(239, 68, 68, 0.50)",
      bottomRight: "rgba(251, 191, 36, 0.20)"
    }
  }
};

const targetConfigs = {
  idle:      { speed: 0.35, spread: 0.46, pulse: 0.04, rotation: 0.06 },
  listening: { speed: 0.45, spread: 0.52, pulse: 0.06, rotation: 0.09 },
  thinking:  { speed: 0.65, spread: 0.40, pulse: 0.05, rotation: 0.14 },
  speaking:  { speed: 0.50, spread: 0.48, pulse: 0.08, rotation: 0.08 },
  error:     { speed: 0.70, spread: 0.55, pulse: 0.10, rotation: 0.18 }
};

// ── 运行状态 ──
let currentState = 'idle';
let speedMultiplier = 0.1; // 固定 0.1x
let visible = false;
let isLoopRunning = false;
let dpr = Math.min(window.devicePixelRatio || 1, 2.0); // 限制 Retina 最大缩放倍率为 2.0，降低高清绘制压力

let animSpeed = targetConfigs.idle.speed;
let animSpread = targetConfigs.idle.spread;
let animPulse = targetConfigs.idle.pulse;
let animRotation = targetConfigs.idle.rotation;
let orbScale = 1;
let opacity = 0;
let wakeScale = 1.0;
let targetWakeScale = 1.0;
let wakeShrinkTimer = null;
let slideOffset = -100;

let gaseousTime = 0;
let globalRotationAngle = 0;
let time = 0;
let lastFrameTime = performance.now();
let smoothedVolume = 0;

// TTS audio analysis
let audioCtx = null;
let analyser = null;
let audioSource = null;
let currentAudio = null;
let currentAudioPath = null;
let interrupted = false;

const canvas = document.getElementById("orbCanvas");
const ctx = canvas.getContext("2d");
const orbContainer = document.getElementById("orbContainer");

function resizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 2.0);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 120;
  const h = rect.height || 120;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.width = w * dpr;
  canvas.height = h * dpr;
}

window.addEventListener('resize', resizeCanvas);
setTimeout(resizeCanvas, 50);

const lerp = (a, b, t) => a + (b - a) * t;

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16)
  };
}

const targetFpsConfig = {
  idle: 12,
  thinking: 18,
  error: 18,
  listening: 24,
  speaking: 24
};

let animFrameId = null;

function startRenderLoop() {
  if (isLoopRunning) return;
  if (!visible || document.hidden) return;
  isLoopRunning = true;
  lastFrameTime = performance.now();
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  animFrameId = requestAnimationFrame(render);
}

function stopRenderLoop() {
  isLoopRunning = false;
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (canvas && ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// ── IPC 通信 ──
diriAPI.onStateUpdate((payload) => {
  try {
    const data = JSON.parse(payload);
    let state = data.state || "idle";
    if (state === "processing") state = "thinking";
    currentState = state;
  } catch (err) {
    logToMain("onStateUpdate error: " + err.message);
  }
});

diriAPI.onShowWindow(() => {
  visible = true;
  wakeScale = 1.0;
  targetWakeScale = 1.0;
  if (wakeShrinkTimer) clearTimeout(wakeShrinkTimer);
  wakeShrinkTimer = setTimeout(() => {
    targetWakeScale = 90 / 120;
  }, 1000);

  startRenderLoop();
});

diriAPI.onHideWindow(() => {
  visible = false;
  if (wakeShrinkTimer) { clearTimeout(wakeShrinkTimer); wakeShrinkTimer = null; }
  stopRenderLoop();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopRenderLoop();
  } else if (visible) {
    startRenderLoop();
  }
});

function logToMain(msg) {
  diriAPI.sendRendererLog("FLOAT_LOG: " + msg);
}

// TTS is application feedback rather than music or video. Keep this renderer
// out of the browser Media Session API as a renderer-side fallback to the
// Windows Chromium feature switch configured in the main process.
function clearSystemMediaSession() {
  if (!navigator.mediaSession) return;
  try { navigator.mediaSession.metadata = null; } catch {}
  try { navigator.mediaSession.playbackState = "none"; } catch {}
  for (const action of ["play", "pause", "previoustrack", "nexttrack", "seekbackward", "seekforward", "seekto", "stop"]) {
    try { navigator.mediaSession.setActionHandler(action, null); } catch {}
  }
}

diriAPI.onTtsPlay((filePath) => {
  logToMain(`[TTS_PERF] Renderer Received: ${filePath}`);
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio = null;
  }
  if (audioSource) { try { audioSource.disconnect(); } catch {} audioSource = null; }
  if (analyser) { try { analyser.disconnect(); } catch {} analyser = null; }
  if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }

  interrupted = false;
  currentAudioPath = filePath;
  clearSystemMediaSession();
  
  const loadStartTime = performance.now();
  currentAudio = new Audio("file://" + filePath);
  logToMain(`[TTS_PERF] Audio Loaded (instantiation took ${(performance.now() - loadStartTime).toFixed(1)}ms): ${filePath}`);

  currentAudio.addEventListener("canplay", () => {
    logToMain(`[TTS_PERF] canplay event fired for ${filePath}`);
  });

  currentAudio.addEventListener("canplaythrough", () => {
    logToMain(`[TTS_PERF] canplaythrough event fired for ${filePath}`);
  });

  currentAudio.addEventListener("playing", clearSystemMediaSession);

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    audioSource = audioCtx.createMediaElementSource(currentAudio);
    audioSource.connect(analyser);
    analyser.connect(audioCtx.destination);
    audioCtx.resume().catch(() => {});
  } catch {}

  currentAudio.onended = () => {
    currentAudio = null;
    if (!interrupted) diriAPI.sendTtsPlayEnded(currentAudioPath);
    currentAudioPath = null;
    cleanupAudio();
  };
  currentAudio.onerror = (err) => {
    logToMain(`[TTS_PERF] Audio error event: ${err ? err.message : "unknown"}`);
    currentAudio = null;
    if (!interrupted) diriAPI.sendTtsPlayEnded(currentAudioPath);
    currentAudioPath = null;
    cleanupAudio();
  };
  
  logToMain(`[TTS_PERF] Calling play() for ${filePath}`);
  const playStartTime = performance.now();
  currentAudio.play()
    .then(() => {
      clearSystemMediaSession();
      logToMain(`[TTS_PERF] play() Promise resolved in ${(performance.now() - playStartTime).toFixed(1)}ms for ${filePath}`);
    })
    .catch((err) => {
      logToMain(`[TTS_PERF] play() Promise rejected: ${err.message} for ${filePath}`);
      currentAudio = null;
      if (!interrupted) diriAPI.sendTtsPlayEnded(currentAudioPath);
      currentAudioPath = null;
      cleanupAudio();
    });
});

diriAPI.onTtsEnd(() => {
  interrupted = true;
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio = null;
  }
  currentAudioPath = null;
  cleanupAudio();
});

function cleanupAudio() {
  clearSystemMediaSession();
  if (audioSource) { try { audioSource.disconnect(); } catch {} audioSource = null; }
  if (analyser) { try { analyser.disconnect(); } catch {} analyser = null; }
  if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
  smoothedVolume = 0;
}

function getAudioVolume() {
  if (analyser) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return sum / data.length / 255;
  }
  if (currentState === 'listening') {
    return 0.12 * Math.sin(time * 0.2) * Math.cos(time * 0.1) +
           0.07 * Math.sin(time * 0.5) + 0.13;
  }
  return 0;
}

// ── 渲染主循环 ──
function render(now = performance.now()) {
  if (!isLoopRunning || !visible || document.hidden) {
    stopRenderLoop();
    return;
  }

  const targetFps = targetFpsConfig[currentState] || 12;
  const frameInterval = 1000 / targetFps;
  const elapsed = now - lastFrameTime;

  if (elapsed >= frameInterval) {
    lastFrameTime = now - (elapsed % frameInterval);

    const w = canvas.width / dpr;
    const h = canvas.height / dpr;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const opacityFactor = visible ? 0.25 : 0.15;
    const slideFactor = visible ? 0.38 : 0.22;

    opacity = lerp(opacity, visible ? 1 : 0, opacityFactor);
    const targetSlideOffset = visible ? 0 : -100;
    slideOffset = lerp(slideOffset, targetSlideOffset, slideFactor);

    if (opacity < 0.003 && !visible) {
      stopRenderLoop();
      return;
    }

    const rawVolume = getAudioVolume();
    smoothedVolume = lerp(smoothedVolume, rawVolume, 0.08);

    const rawDt = elapsed / 1000;
    const dt = Math.min(0.08, rawDt) * speedMultiplier;

    const targetConfig = targetConfigs[currentState] || targetConfigs.idle;
    animSpeed = lerp(animSpeed, targetConfig.speed, 0.04);
    animSpread = lerp(animSpread, targetConfig.spread, 0.04);
    animPulse = lerp(animPulse, targetConfig.pulse, 0.04);
    animRotation = lerp(animRotation, targetConfig.rotation, 0.03);

    gaseousTime += animSpeed * dt * 60;
    globalRotationAngle += animRotation * dt * 9;
    time += dt * 60;

    let baseScale = 1.0;
    if (currentState === 'speaking') baseScale += smoothedVolume * 0.11;
    else if (currentState === 'listening') baseScale += smoothedVolume * 0.07;
    const breath = 1.0 + Math.sin(time * 0.4) * animPulse;
    orbScale = lerp(orbScale, baseScale * breath, 0.04);
    wakeScale = lerp(wakeScale, targetWakeScale, 0.04);

    let shakeX = 0, shakeY = 0;
    if (currentState === 'error') {
      shakeX = Math.sin(time * 65) * 2.5;
      shakeY = Math.cos(time * 55) * 2.5;
    }

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.scale(dpr, dpr);
    ctx.translate(w / 2 + shakeX, h / 2 + shakeY + slideOffset);
    ctx.scale(orbScale * wakeScale, orbScale * wakeScale);
    ctx.translate(-w / 2, -h / 2);

    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2 - 6;

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

    drawSphereBase(cx, cy, radius, currentState);
    drawNeonFilaments(cx, cy, radius, smoothedVolume, currentState);
    drawInnerShadow(cx, cy, radius, isDark);
    drawGlassWallRefraction(cx, cy, radius);

    ctx.restore();

    drawGlassHighlights(cx, cy, radius, currentState, isDark);
    ctx.restore();
  }

  if (isLoopRunning && visible && !document.hidden) {
    animFrameId = requestAnimationFrame(render);
  }
}

function drawSphereBase(cx, cy, radius, activeState) {
  const palette = palettes[activeState] || palettes.idle;

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  const baseGrad = ctx.createLinearGradient(
    cx - radius, cy - radius,
    cx + radius, cy + radius
  );
  
  baseGrad.addColorStop(0, palette.linearGradient.topLeft);
  baseGrad.addColorStop(0.5, palette.linearGradient.middle);
  baseGrad.addColorStop(1, palette.linearGradient.bottomRight);

  ctx.fillStyle = baseGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawNeonFilaments(cx, cy, radius, vol, activeState) {
  const palette = palettes[activeState] || palettes.idle;
  const colors = palette.filaments;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.translate(cx, cy);
  ctx.rotate(globalRotationAngle);
  ctx.translate(-cx, -cy);

  for (let i = 0; i < colors.length; i++) {
    const rgb = hexToRgb(colors[i]);
    const speedFactor = gaseousTime * (0.60 + i * 0.05) + i * 2.0;

    const drawPath = () => {
      ctx.beginPath();
      const points = 144;
      for (let j = 0; j <= points; j++) {
        const angle = (j / points) * Math.PI * 2;
        let wave1 = 0;
        let wave2 = 0;
        if (i === 0) {
          wave1 = Math.sin(angle * 3.0 + speedFactor * 1.3) * 5.6;
          wave2 = Math.cos(angle * 2.0 - speedFactor * 0.7) * 3.4;
        } else if (i === 1) {
          wave1 = Math.sin(angle * 4.0 - speedFactor * 0.9) * 4.5;
          wave2 = Math.cos(angle * 3.0 + speedFactor * 1.1) * 3.8;
        } else {
          wave1 = Math.sin(angle * 2.0 + speedFactor * 0.6) * 6.0;
          wave2 = Math.cos(angle * 5.0 - speedFactor * 1.4) * 3.0;
        }
        const waveVolume = (activeState === "speaking" || activeState === "listening") ? vol * 9.5 : 0;
        const r_base = radius * (0.81 - i * 0.04);
        const r = r_base + wave1 + wave2 + waveVolume * Math.sin(angle * 4.0 + gaseousTime * 4);
        const cos_tilt = (i === 0) ? 0.95 : 0.68;
        const x_local = Math.cos(angle) * r;
        const y_local = Math.sin(angle) * r * cos_tilt;
        const tilt_angle = (i === 0) ? -Math.PI / 12 : (i === 1 ? Math.PI / 3.2 : -Math.PI / 3.2);
        
        const x = cx + x_local * Math.cos(tilt_angle) - y_local * Math.sin(tilt_angle);
        const y = cy + x_local * Math.sin(tilt_angle) + y_local * Math.cos(tilt_angle);
        
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };

    drawPath();
    ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    drawPath();
    const centerAlpha = (activeState === "speaking" || activeState === "listening") ? 0.70 + vol * 0.25 : 0.62;
    ctx.strokeStyle = `rgba(${Math.floor(lerp(rgb.r, 255, 0.45))}, ${Math.floor(lerp(rgb.g, 255, 0.45))}, ${Math.floor(lerp(rgb.b, 255, 0.45))}, ${centerAlpha})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

function drawInnerShadow(cx, cy, radius, isDark) {
  const innerShadow = ctx.createRadialGradient(
    cx + radius * 0.05, cy + radius * 0.08, radius * 0.75,
    cx + radius * 0.08, cy + radius * 0.12, radius * 1.05
  );
  innerShadow.addColorStop(0, "rgba(0, 0, 0, 0)");
  innerShadow.addColorStop(0.8, "rgba(0, 0, 0, 0)");
  innerShadow.addColorStop(0.92, isDark ? "rgba(0, 0, 0, 0.04)" : "rgba(0, 0, 0, 0.01)");
  innerShadow.addColorStop(1, isDark ? "rgba(0, 0, 0, 0.12)" : "rgba(0, 0, 0, 0.04)");
  
  ctx.fillStyle = innerShadow;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
}

function drawGlassWallRefraction(cx, cy, radius) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 1.2, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 2.0;
  ctx.stroke();

  const wallGrad = ctx.createRadialGradient(cx, cy, radius * 0.93, cx, cy, radius);
  wallGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
  wallGrad.addColorStop(0.85, "rgba(255, 255, 255, 0.02)");
  wallGrad.addColorStop(1, "rgba(255, 255, 255, 0.12)");
  
  ctx.fillStyle = wallGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawGlassHighlights(cx, cy, radius, activeState, isDark) {
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 1.0, -Math.PI * 0.85, -Math.PI * 0.15);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, radius - 1.2, Math.PI * 0.5, Math.PI * 0.95);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
  ctx.lineWidth = 1.0;
  ctx.stroke();
}

// ── 鼠标穿透智能判断 ──
let isMouseOverInteractiveElement = false;
window.addEventListener("mousemove", (e) => {
  const isOverOrb = isPointInOrb(e.clientX, e.clientY);
  if (isOverOrb !== isMouseOverInteractiveElement) {
    isMouseOverInteractiveElement = isOverOrb;
    diriAPI.setIgnoreMouse(!isMouseOverInteractiveElement);
  }
});

function isPointInOrb(x, y) {
  if (!visible || !canvas) return false;

  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const radiusX = rect.width / 2;
  const radiusY = rect.height / 2;
  const normalizedX = (x - (rect.left + radiusX)) / radiusX;
  const normalizedY = (y - (rect.top + radiusY)) / radiusY;
  return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
}

// A click while Daisy is delivering a final answer only mutes that answer's
// speech. The main process intentionally keeps the answer state and panel open.
canvas.addEventListener("click", () => {
  if (currentState === "speaking") {
    diriAPI.muteCurrentTts();
  }
});

resizeCanvas();
