/**
 * Daisy - Landing Page Interactive Script (Apple Fluid Interfaces Edition)
 */

// 1. Spring Physics Solver (Distilled from WWDC 2018 / Designing Fluid Interfaces)
class Spring {
  constructor(value, tension = 180, friction = 22) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.tension = tension;
    this.friction = friction;
  }

  update(dt) {
    const force = (this.target - this.value) * this.tension;
    const damping = -this.velocity * this.friction;
    const acceleration = force + damping;
    this.velocity += acceleration * dt;
    this.value += this.velocity * dt;
  }
}

class Spring2D {
  constructor(x, y, tension = 150, friction = 18) {
    this.x = new Spring(x, tension, friction);
    this.y = new Spring(y, tension, friction);
  }

  setTarget(x, y) {
    this.x.target = x;
    this.y.target = y;
  }

  update(dt) {
    this.x.update(dt);
    this.y.update(dt);
  }
}

// 2. Daisy Interactive Orb Engine with Spring transitions & Drag-to-Throw Snapping
class DaisyOrb {
  constructor(canvasId, size, initialState = 'idle') {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    if (!this.ctx) return;

    this.size = size;
    this.state = initialState;
    this.animationFrameId = null;
    this.gaseousTime = 0;
    this.globalRotationAngle = 0;
    this.time = 0;
    this.lastFrameTime = performance.now();
    this.frameInterval = 1000 / 30; // 30 FPS target for rendering

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = this.size * this.dpr;
    this.canvas.height = this.size * this.dpr;
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;

    // Colors
    this.palette = {
      main: "#6C6EF5",
      mid: "#30268a",
      dark: "#140c38",
      highlight: "#C5C1FF",
      filaments: ["#6C6EF5", "#EC4899", "#8B5CF6"],
      linearGradient: {
        topLeft: "rgba(108, 110, 245, 0.85)",
        middle: "rgba(139, 92, 246, 0.50)",
        bottomRight: "rgba(236, 72, 153, 0.20)"
      }
    };

    this.errorPalette = {
      main: "#EF4444",
      mid: "#781c1c",
      dark: "#380c0c",
      highlight: "#FCA5A5",
      filaments: ["#EF4444", "#F59E0B", "#DC2626"],
      linearGradient: {
        topLeft: "rgba(239, 68, 68, 0.85)",
        middle: "rgba(245, 158, 11, 0.50)",
        bottomRight: "rgba(220, 38, 38, 0.20)"
      }
    };

    // State presets
    this.presets = {
      idle: { speed: 0.35, spread: 0.46, pulse: 0.04, rotation: 0.06 },
      listening: { speed: 0.75, spread: 0.58, pulse: 0.12, rotation: 0.15 },
      thinking: { speed: 1.35, spread: 0.38, pulse: 0.07, rotation: 0.45 },
      speaking: { speed: 0.85, spread: 0.52, pulse: 0.15, rotation: 0.08 },
      error: { speed: 0.20, spread: 0.48, pulse: 0.03, rotation: 0.03 }
    };

    const initialPreset = this.presets[initialState];

    // Initialize physical springs for smooth parameter transitions
    this.speedSpring = new Spring(initialPreset.speed, 140, 16);
    this.spreadSpring = new Spring(initialPreset.spread, 140, 16);
    this.pulseSpring = new Spring(initialPreset.pulse, 120, 14);
    this.rotationSpeedSpring = new Spring(initialPreset.rotation, 140, 16);
    
    // Snapping spring for drag/throw (Rule 4: Move/PiP spring values)
    this.dragSpring = new Spring2D(0, 0, 150, 18);
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.lastDragPos = { x: 0, y: 0 };
    this.dragVelocity = { x: 0, y: 0 };

    this.setupInteraction();
    this.start();
  }

  setState(newState) {
    if (this.presets[newState]) {
      this.state = newState;
      const target = this.presets[newState];
      
      // Update targets of the springs (Rule 3: Springs animate from current value by default)
      this.speedSpring.target = target.speed;
      this.spreadSpring.target = target.spread;
      this.pulseSpring.target = target.pulse;
      this.rotationSpeedSpring.target = target.rotation;
    }
  }

  // Hook mouse events for interactive dragging & snapback springs (Rule 2 & 6)
  setupInteraction() {
    this.canvas.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      this.dragStart.x = e.clientX - this.dragSpring.x.value;
      this.dragStart.y = e.clientY - this.dragSpring.y.value;
      this.lastDragPos.x = e.clientX;
      this.lastDragPos.y = e.clientY;
      this.dragVelocity = { x: 0, y: 0 };
      
      // Trigger listening state on grab
      if (this.size > 80) { // Only for main Hero Orb
        this.setState('listening');
        const tag = document.getElementById('orbStateTag');
        if (tag) {
          tag.innerText = '抓取中...';
          tag.style.color = '#8B5CF6';
        }
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.isDragging) return;
      
      const x = e.clientX - this.dragStart.x;
      const y = e.clientY - this.dragStart.y;
      
      // Update spring values instantly on drag (direct manipulation)
      this.dragSpring.x.value = x;
      this.dragSpring.y.value = y;
      
      // Track velocity history for momentum handoff
      this.dragVelocity.x = e.clientX - this.lastDragPos.x;
      this.dragVelocity.y = e.clientY - this.lastDragPos.y;
      
      this.lastDragPos.x = e.clientX;
      this.lastDragPos.y = e.clientY;
    });

    this.canvas.addEventListener('pointerup', () => {
      if (!this.isDragging) return;
      this.isDragging = false;
      
      // Handoff release velocity to snap springs (Rule 5)
      this.dragSpring.x.velocity = this.dragVelocity.x * 60; // scale to px/s
      this.dragSpring.y.velocity = this.dragVelocity.y * 60;
      
      // Reset targets to center (snap back)
      this.dragSpring.setTarget(0, 0);

      if (this.size > 80) {
        this.setState('idle');
        const tag = document.getElementById('orbStateTag');
        if (tag) {
          tag.innerText = '已释放';
          tag.style.color = '#6C6EF5';
          setTimeout(() => {
            if (this.state === 'idle') tag.innerText = '闲置中';
          }, 1000);
        }
      }
    });
  }

  drawSphereBase(cx, cy, radius, activePalette) {
    this.ctx.fillStyle = "#ffffff";
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    this.ctx.fill();

    const baseGrad = this.ctx.createLinearGradient(
      cx - radius, cy - radius,
      cx + radius, cy + radius
    );
    baseGrad.addColorStop(0, activePalette.linearGradient.topLeft);
    baseGrad.addColorStop(0.5, activePalette.linearGradient.middle);
    baseGrad.addColorStop(1, activePalette.linearGradient.bottomRight);

    this.ctx.fillStyle = baseGrad;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    this.ctx.fill();
  }

  drawNeonFilaments(cx, cy, radius, activePalette, spread) {
    this.ctx.save();
    this.ctx.globalCompositeOperation = "screen";
    this.ctx.translate(cx, cy);
    this.ctx.rotate(this.globalRotationAngle);
    this.ctx.translate(-cx, -cy);

    const rgbFilaments = activePalette.filaments.map(h => {
      const clean = h.replace("#", "");
      return {
        r: parseInt(clean.substring(0, 2), 16),
        g: parseInt(clean.substring(2, 4), 16),
        b: parseInt(clean.substring(4, 6), 16)
      };
    });

    for (let i = 0; i < rgbFilaments.length; i++) {
      const rgb = rgbFilaments[i];
      const speedFactor = this.gaseousTime * (0.60 + i * 0.05) + i * 2.0;

      const drawPath = () => {
        this.ctx.beginPath();
        const points = 60;
        for (let j = 0; j <= points; j++) {
          const angle = (j / points) * Math.PI * 2;
          let wave1 = 0;
          let wave2 = 0;
          
          if (this.state === 'listening') {
            wave1 = Math.sin(angle * 4.0 + speedFactor * 1.8) * 2.2;
            wave2 = Math.cos(angle * 3.0 - speedFactor * 1.1) * 1.5;
          } else if (this.state === 'thinking') {
            wave1 = Math.sin(angle * 2.0 + speedFactor * 2.2) * 0.9;
            wave2 = Math.cos(angle * 5.0 - speedFactor * 1.8) * 0.5;
          } else if (this.state === 'speaking') {
            wave1 = Math.sin(angle * 3.0 + speedFactor * 1.4) * 2.8 * (0.3 + Math.sin(this.time * 0.5));
            wave2 = Math.cos(angle * 2.0 - speedFactor * 0.9) * 1.6;
          } else { // idle / error
            wave1 = Math.sin(angle * 3.0 + speedFactor * 1.3) * 1.2;
            wave2 = Math.cos(angle * 2.0 - speedFactor * 0.7) * 0.8;
          }

          const r_base = radius * (spread - i * 0.04);
          const r = r_base + wave1 + wave2;
          const cos_tilt = (i === 0) ? 0.95 : 0.68;
          const x_local = Math.cos(angle) * r;
          const y_local = Math.sin(angle) * r * cos_tilt;
          const tilt_angle = (i === 0) ? -Math.PI / 12 : (i === 1 ? Math.PI / 3.2 : -Math.PI / 3.2);
          const x = cx + x_local * Math.cos(tilt_angle) - y_local * Math.sin(tilt_angle);
          const y = cy + x_local * Math.sin(tilt_angle) + y_local * Math.cos(tilt_angle);
          
          if (j === 0) this.ctx.moveTo(x, y);
          else this.ctx.lineTo(x, y);
        }
        this.ctx.closePath();
      };

      // Outer soft glow
      drawPath();
      this.ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.16)`;
      this.ctx.lineWidth = 3.0;
      this.ctx.lineCap = "round";
      this.ctx.lineJoin = "round";
      this.ctx.stroke();

      // Inner filament core
      drawPath();
      const centerAlpha = this.state === 'thinking' ? 0.80 : 0.60;
      this.ctx.strokeStyle = `rgba(${Math.floor(rgb.r + (255 - rgb.r) * 0.45)}, ${Math.floor(rgb.g + (255 - rgb.g) * 0.45)}, ${Math.floor(rgb.b + (255 - rgb.b) * 0.45)}, ${centerAlpha})`;
      this.ctx.lineWidth = 0.8;
      this.ctx.stroke();
    }
    this.ctx.restore();
  }

  drawInnerShadow(cx, cy, radius) {
    const innerShadow = this.ctx.createRadialGradient(
      cx + radius * 0.05, cy + radius * 0.08, radius * 0.75,
      cx + radius * 0.08, cy + radius * 0.12, radius * 1.05
    );
    innerShadow.addColorStop(0, "rgba(0, 0, 0, 0)");
    innerShadow.addColorStop(0.8, "rgba(0, 0, 0, 0)");
    innerShadow.addColorStop(0.92, "rgba(0, 0, 0, 0.01)");
    innerShadow.addColorStop(1, "rgba(0, 0, 0, 0.05)");
    this.ctx.fillStyle = innerShadow;
    this.ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }

  drawGlassWallRefraction(cx, cy, radius) {
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius - 0.5, 0, Math.PI * 2);
    this.ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    this.ctx.lineWidth = 1.0;
    this.ctx.stroke();

    const wallGrad = this.ctx.createRadialGradient(cx, cy, radius * 0.93, cx, cy, radius);
    wallGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
    wallGrad.addColorStop(0.85, "rgba(255, 255, 255, 0.02)");
    wallGrad.addColorStop(1, "rgba(255, 255, 255, 0.10)");
    this.ctx.fillStyle = wallGrad;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.restore();
  }

  drawGlassHighlights(cx, cy, radius) {
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius - 0.5, -Math.PI * 0.85, -Math.PI * 0.15);
    this.ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
    this.ctx.lineWidth = 0.8;
    this.ctx.lineCap = "round";
    this.ctx.stroke();

    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius - 0.6, Math.PI * 0.5, Math.PI * 0.95);
    this.ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    this.ctx.lineWidth = 0.5;
    this.ctx.stroke();
  }

  renderFrame(now) {
    if (!this.canvas || !this.ctx) return;
    this.animationFrameId = requestAnimationFrame(this.renderFrame.bind(this));

    const rawDt = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    const dt = Math.min(0.05, rawDt); // Cap frame delta for stability

    // 1. Update Springs
    this.speedSpring.update(dt);
    this.spreadSpring.update(dt);
    this.pulseSpring.update(dt);
    this.rotationSpeedSpring.update(dt);
    
    if (!this.isDragging) {
      this.dragSpring.update(dt);
    }

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const activePalette = this.state === 'error' ? this.errorPalette : this.palette;

    // Advance particle times based on spring values
    this.gaseousTime += this.speedSpring.value * dt * 30;
    this.globalRotationAngle += this.rotationSpeedSpring.value * dt * 9;
    this.time += dt * 30;

    const breath = 1.0 + Math.sin(this.time * 0.4) * this.pulseSpring.value;

    this.ctx.save();
    this.ctx.scale(this.dpr, this.dpr);
    
    // Apply physical drag position coordinates
    this.ctx.translate(this.dragSpring.x.value, this.dragSpring.y.value);

    // Apply breathing scaling
    this.ctx.translate(this.size / 2, this.size / 2);
    this.ctx.scale(breath, breath);
    this.ctx.translate(-this.size / 2, -this.size / 2);

    const cx = this.size / 2;
    const cy = this.size / 2;
    const radius = Math.min(this.size, this.size) / 2 - 3;

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    this.ctx.clip();

    this.drawSphereBase(cx, cy, radius, activePalette);
    this.drawNeonFilaments(cx, cy, radius, activePalette, this.spreadSpring.value);
    this.drawInnerShadow(cx, cy, radius);
    this.drawGlassWallRefraction(cx, cy, radius);

    this.ctx.restore();

    this.drawGlassHighlights(cx, cy, radius);
    this.ctx.restore();
  }

  start() {
    this.animationFrameId = requestAnimationFrame(this.renderFrame.bind(this));
  }

  destroy() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }
  }
}

// 3. Simulated Scenarios action parameters
const scenarios = {
  dnd: {
    prompt: "“开启勿扰模式，顺便把 VS Code 和 Chrome 左右分屏”",
    reply: "好的，已为您开启系统勿扰模式，并将 VS Code 和 Google Chrome 进行左右分屏排版。",
    action: (elements) => {
      elements.dndIndicator.classList.remove('active');
      elements.splitScreenMock.classList.remove('split');
      elements.vscode.classList.remove('visible');
      elements.chrome.classList.remove('visible');
      
      setTimeout(() => {
        elements.dndIndicator.classList.add('active');
        elements.splitScreenMock.classList.add('split');
      }, 800);

      setTimeout(() => {
        elements.vscode.classList.add('visible');
      }, 1100);

      setTimeout(() => {
        elements.chrome.classList.add('visible');
      }, 1300);
    }
  },
  vlm: {
    prompt: "“看一眼当前屏幕，帮我总结一下代码报错”",
    reply: "好的，我正通过截屏查看您的前台窗口...检测到您的 Node.js 项目在编译时发生异常：在 App.tsx 的第 243 行发生了 'TypeError: Cannot read properties of undefined (reading 'map')' 错误。这通常是因为 `settings.filaments` 未正确初始化为数组。建议添加保护性检查，例如 `settings.filaments || []`。",
    action: (elements) => {
      elements.splitScreenMock.innerHTML = `
        <div class="mock-app mock-vscode visible" style="width: 100%; height: 100%;">
          <div class="app-title-bar">Terminal Error logs</div>
          <div class="vscode-body" style="font-family: monospace; font-size: 11px; padding: 16px; background: #0f1419; color: #ff4d4d; border-radius: 0 0 8px 8px;">
            <div>[ERROR] TypeError: Cannot read properties of undefined (reading 'map')</div>
            <div style="color: #64748b; margin-top: 4px;">&nbsp;&nbsp;&nbsp;&nbsp;at IdleOrb.tsx:186:44</div>
            <div style="color: #64748b;">&nbsp;&nbsp;&nbsp;&nbsp;at React.useEffect (react.development.js:1240)</div>
            <div style="color: #f59e0b; margin-top: 12px;">Waiting for voice input summary...</div>
          </div>
        </div>
      `;
    }
  },
  audio: {
    prompt: "“把音频输出切换到 AirPods 蓝牙耳机”",
    reply: "好的，已切换音频输出。正在切换至设备「AirPods Pro」...",
    action: (elements) => {
      elements.splitScreenMock.innerHTML = `
        <div class="graphic-card" style="margin: auto; width: 280px;">
          <div class="card-nav">
            <span class="c-dot"></span><span class="c-dot"></span><span class="c-dot"></span>
            <span class="card-label">音频设备输出路由</span>
          </div>
          <div class="audio-list-mock">
            <div class="audio-item">内置扬声器 (Built-in Speaker)</div>
            <div class="audio-item active" id="airpodsItem">AirPods Pro <span class="active-tag">✓ 正在连接...</span></div>
            <div class="audio-item">SSL 2 USB Interface (2ch)</div>
            <div class="audio-item">Dell Monitor Audio output</div>
          </div>
          <div class="audio-command-overlay" id="audioOverlay">
            <div class="command-bubble">“已切换至 AirPods Pro”</div>
          </div>
        </div>
      `;

      setTimeout(() => {
        const item = document.getElementById('airpodsItem');
        if (item) item.innerHTML = `AirPods Pro <span class="active-tag">✓ 当前活动</span>`;
        const overlay = document.getElementById('audioOverlay');
        if (overlay) overlay.classList.add('visible');
      }, 1200);
    }
  },
  pdf: {
    prompt: "“在合同的‘签名处’填入我的名字，生成新 PDF”",
    reply: "好的，正在使用 PyMuPDF 进行 PDF 文本搜索定位...已在第 4 页、第 12 页的 [签名处] 锚点右侧填入文本 'Daisy User'，字号自适应为 10.5，新文件已保存至桌面 contract_signed.pdf。",
    action: (elements) => {
      elements.splitScreenMock.innerHTML = `
        <div class="mock-app mock-chrome visible" style="width: 100%; height: 100%;">
          <div class="app-title-bar">Preview - contract_signed.pdf</div>
          <div class="chrome-body" style="padding: 12px; background: #94a3b8; display: flex; justify-content: center; align-items: center;">
            <div style="background: #ffffff; width: 85%; height: 100%; box-shadow: 0 4px 10px rgba(0,0,0,0.1); padding: 18px; position: relative; border-radius: 4px;">
              <h4 style="font-size: 11px; text-align: center; margin-bottom: 16px;">软件定制开发合同协议书</h4>
              <div style="height: 4px; background: #e2e8f0; width: 90%; margin-bottom: 6px;"></div>
              <div style="height: 4px; background: #e2e8f0; width: 90%; margin-bottom: 6px;"></div>
              <div style="height: 4px; background: #e2e8f0; width: 55%; margin-bottom: 24px;"></div>
              <div style="position: absolute; bottom: 30px; right: 20px; border: 1px dashed #6C6EF5; padding: 4px 8px; font-family: sans-serif; font-size: 9px;">
                甲方签名: <span style="font-weight: bold; color: #6C6EF5; font-style: italic;">Daisy User</span>
              </div>
            </div>
          </div>
        </div>
      `;
    }
  },
  clipboard: {
    prompt: "“帮我把剪贴板刚才复制的截图保存到桌面”",
    reply: "好的，已成功提取您剪贴板中的 PNG 图片数据，并自动将其命名为 剪贴板图片_20260718_1440.png 保存到您的桌面。",
    action: (elements) => {
      elements.splitScreenMock.innerHTML = `
        <div class="mock-app mock-chrome visible" style="width: 250px; height: 160px; margin: auto;">
          <div class="app-title-bar">Finder - 桌面 (Desktop)</div>
          <div class="chrome-body" style="padding: 10px; display: flex; flex-direction: column; justify-content: center; align-items: center; background: #ffffff;">
            <svg viewBox="0 0 24 24" fill="none" stroke="#6C6EF5" stroke-width="2" style="width: 40px; height: 40px; margin-bottom: 6px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            <div style="font-size: 9px; font-weight: bold; color: #1e293b; text-align: center;">剪贴板图片_20260718_1440.png</div>
            <div style="font-size: 8px; color: #858585; margin-top: 2px;">今天 14:40 • 868 KB</div>
          </div>
        </div>
      `;
    }
  }
};

// 4. Page Controller
document.addEventListener('DOMContentLoaded', () => {
  // Instantiate Orbs with smooth spring states
  const navOrb = new DaisyOrb('logoOrbCanvas', 24, 'idle');
  const heroOrb = new DaisyOrb('heroOrbCanvas', 150, 'idle');
  const simOrb = new DaisyOrb('simOrbCanvas', 44, 'idle');

  // Hero Orb State tag interactions
  const orbStateTag = document.getElementById('orbStateTag');
  const heroCanvas = document.getElementById('heroOrbCanvas');
  
  if (heroCanvas && orbStateTag) {
    heroCanvas.addEventListener('mouseenter', () => {
      heroOrb.setState('listening');
      orbStateTag.innerText = '聆听指令中';
      orbStateTag.style.color = '#8B5CF6';
      orbStateTag.style.transform = 'translateY(-2px)';
    });

    heroCanvas.addEventListener('mouseleave', () => {
      if (!heroOrb.isDragging) {
        heroOrb.setState('idle');
        orbStateTag.innerText = '闲置中';
        orbStateTag.style.color = '#1d1d1f';
        orbStateTag.style.transform = 'translateY(0)';
      }
    });

    heroCanvas.addEventListener('click', () => {
      if (heroOrb.isDragging) return;
      heroOrb.setState('thinking');
      orbStateTag.innerText = '思考解析中';
      orbStateTag.style.color = '#EC4899';
      
      setTimeout(() => {
        heroOrb.setState('speaking');
        orbStateTag.innerText = '语音播报中';
        orbStateTag.style.color = '#0071e3';
      }, 1600);
    });
  }

  // Simulator scenario triggers on pointer-down (Rule 1: Respond on pointer-down)
  const promptButtons = document.querySelectorAll('.prompt-btn');
  const simAsrText = document.getElementById('simAsrText');
  const simReplyText = document.getElementById('simReplyText');
  const simSpeechBubble = document.getElementById('simSpeechBubble');
  
  const simElements = {
    dndIndicator: document.getElementById('simDndIndicator'),
    splitScreenMock: document.getElementById('splitScreenMock'),
    vscode: document.querySelector('.mock-vscode'),
    chrome: document.querySelector('.mock-chrome')
  };

  const initialSplitScreenHtml = simElements.splitScreenMock.innerHTML;
  let bubbleSpringScale = new Spring(0, 180, 20); // Spring for bubble opening scale
  let bubbleSpringOpacity = new Spring(0, 150, 18);
  
  // Custom loop to animate speech bubble via Springs (Rule 3 & 4)
  function animBubble() {
    bubbleSpringScale.update(0.016);
    bubbleSpringOpacity.update(0.016);
    
    simSpeechBubble.style.transform = `translateY(${(1 - bubbleSpringScale.value) * 10}px) scale(${bubbleSpringScale.value})`;
    simSpeechBubble.style.opacity = bubbleSpringOpacity.value;
    
    if (bubbleSpringOpacity.value > 0.01 || bubbleSpringOpacity.target > 0.5) {
      requestAnimationFrame(animBubble);
    }
  }

  let activeTimeout1 = null;
  let activeTimeout2 = null;
  let activeTimeout3 = null;

  function runScenario(key) {
    const scenario = scenarios[key];
    if (!scenario) return;

    // Reset timeouts to make interactions fully interruptible (Rule 3)
    if (activeTimeout1) clearTimeout(activeTimeout1);
    if (activeTimeout2) clearTimeout(activeTimeout2);
    if (activeTimeout3) clearTimeout(activeTimeout3);

    // Fade out bubble instantly before redirecting
    bubbleSpringScale.target = 0.8;
    bubbleSpringOpacity.target = 0;
    animBubble();

    simOrb.setState('listening');

    // Type prompt
    activeTimeout1 = setTimeout(() => {
      simAsrText.innerText = scenario.prompt;
      bubbleSpringScale.target = 1.0;
      bubbleSpringOpacity.target = 1.0;
      animBubble();
    }, 200);

    // Think
    activeTimeout2 = setTimeout(() => {
      simOrb.setState('thinking');
    }, 1100);

    // Speak / Perform UI Actions
    activeTimeout3 = setTimeout(() => {
      simOrb.setState('speaking');
      simReplyText.innerText = scenario.reply;
      
      // Restore layout template
      simElements.splitScreenMock.innerHTML = initialSplitScreenHtml;
      simElements.vscode = document.querySelector('.mock-vscode');
      simElements.chrome = document.querySelector('.mock-chrome');

      scenario.action(simElements);
    }, 2400);
  }

  promptButtons.forEach(btn => {
    // Rule 1: Respond on pointerdown, not click
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      promptButtons.forEach(b => b.classList.remove('active'));
      const targetBtn = e.currentTarget;
      targetBtn.classList.add('active');

      const scenarioKey = targetBtn.getAttribute('data-scenario');
      runScenario(scenarioKey);
    });
  });

  // Load first scenario initially
  setTimeout(() => {
    runScenario('dnd');
  }, 800);

  // Download Trigger
  const dmgDownloadBtn = document.getElementById('dmgDownloadBtn');
  if (dmgDownloadBtn) {
    dmgDownloadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      alert('Daisy v2.1.5 macOS arm64 预览版已在本地就绪。本网站正式环境部署完成后，即可一键下载！');
    });
  }
});
