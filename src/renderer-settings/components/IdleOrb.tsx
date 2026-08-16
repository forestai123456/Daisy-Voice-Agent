import React, { useEffect, useRef } from "react";

export const IdleOrb: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = 52;
    const h = 52;
    const isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const palette = {
      main: "#6C6EF5",
      mid: "#30268a",
      dark: "#140c38",
      deepDark: "#0d0728",
      highlight: "#C5C1FF",
      glow: "rgba(108, 110, 245, 0.45)",
      filaments: ["#6C6EF5", "#EC4899", "#8B5CF6"],
      linearGradient: {
        topLeft: "rgba(108, 110, 245, 0.85)",
        middle: "rgba(139, 92, 246, 0.50)",
        bottomRight: "rgba(236, 72, 153, 0.20)"
      }
    };

    function hexToRgb(hex: string) {
      const clean = hex.replace("#", "");
      return {
        r: parseInt(clean.substring(0, 2), 16),
        g: parseInt(clean.substring(2, 4), 16),
        b: parseInt(clean.substring(4, 6), 16)
      };
    }

    const rgbFilaments = palette.filaments.map(hexToRgb);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(dpr, dpr);

    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) / 2 - 3;

    // Draw sphere base
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    const baseGrad = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
    baseGrad.addColorStop(0, palette.linearGradient.topLeft);
    baseGrad.addColorStop(0.5, palette.linearGradient.middle);
    baseGrad.addColorStop(1, palette.linearGradient.bottomRight);

    ctx.fillStyle = baseGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    // Draw static neon filaments
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    for (let i = 0; i < rgbFilaments.length; i++) {
      const rgb = rgbFilaments[i];
      ctx.beginPath();
      const points = 72;
      for (let j = 0; j <= points; j++) {
        const angle = (j / points) * Math.PI * 2;
        const wave1 = Math.sin(angle * 3.0 + i * 1.5) * 1.2;
        const wave2 = Math.cos(angle * 2.0 - i * 1.2) * 0.8;
        const r_base = radius * (0.81 - i * 0.04);
        const r = r_base + wave1 + wave2;
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

      ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
      ctx.lineWidth = 3.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();

      const centerAlpha = 0.62;
      ctx.strokeStyle = `rgba(${Math.floor(rgb.r + (255 - rgb.r) * 0.45)}, ${Math.floor(rgb.g + (255 - rgb.g) * 0.45)}, ${Math.floor(rgb.b + (255 - rgb.b) * 0.45)}, ${centerAlpha})`;
      ctx.lineWidth = 0.75;
      ctx.stroke();
    }
    ctx.restore();

    // Draw inner shadow
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

    // Draw glass wall refraction
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 1.0;
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

    // Draw glass highlights
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 0.5, -Math.PI * 0.85, -Math.PI * 0.15);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 0.8;
    ctx.lineCap = "round";
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, radius - 0.6, Math.PI * 0.5, Math.PI * 0.95);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
    ctx.lineWidth = 0.5;
    ctx.stroke();

    ctx.restore();
  }, []);

  return (
    <div className="relative w-[52px] h-[52px] flex items-center justify-center select-none pointer-events-none">
      <div className="absolute inset-1 rounded-full bg-[#6C6EF5]/15 blur-md" />
      <canvas
        ref={canvasRef}
        style={{ width: "52px", height: "52px", contain: "strict", transform: "translateZ(0)" }}
        className="relative z-10 block"
      />
    </div>
  );
};
