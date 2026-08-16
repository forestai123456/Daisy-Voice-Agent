export const FLOAT_ORB_SIZE = 92;

export interface FloatDisplayBounds {
  x: number;
  y: number;
  width: number;
}

export interface FloatWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Keep the orb centered at the top edge on Windows and slightly above it on macOS. */
export function calculateFloatWindowBounds(
  display: FloatDisplayBounds,
  width = FLOAT_ORB_SIZE,
  height = FLOAT_ORB_SIZE,
  platform: NodeJS.Platform = process.platform,
): FloatWindowBounds {
  return {
    x: display.x + Math.round((display.width - width) / 2),
    y: display.y + (platform === "win32" ? 0 : -20),
    width,
    height,
  };
}

