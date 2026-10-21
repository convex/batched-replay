// Procedural textures for the 3D tilt demo, drawn on a canvas so nothing is
// downloaded: wood grain, and a soft round shadow.
import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";

// A small seeded random, so the grain looks the same on every load.
export function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type WoodOptions = {
  width: number;
  height: number;
  base: string;
  dark: string;
  light: string;
  seed: number;
  // Grain lines per 100 px of height.
  density?: number;
  // Draw markings on top of the grain, in canvas pixels.
  paint?: (ctx: CanvasRenderingContext2D) => void;
};

// Grain runs along the texture's width (u), so lay boards out along u.
export function woodTexture({
  width,
  height,
  base,
  dark,
  light,
  seed,
  density = 12,
  paint,
}: WoodOptions) {
  const random = seeded(seed);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  // Broad bands of lighter and darker wood.
  for (let i = 0; i < 18; i++) {
    const y = random() * height;
    const band = ctx.createLinearGradient(0, y - 60, 0, y + 60);
    const tone = random() < 0.5 ? dark : light;
    band.addColorStop(0, "transparent");
    band.addColorStop(0.5, tone);
    band.addColorStop(1, "transparent");
    ctx.globalAlpha = 0.08 + random() * 0.12;
    ctx.fillStyle = band;
    ctx.fillRect(0, y - 60, width, 120);
  }

  // Fine grain: long wavy lines, each slightly different.
  const lines = Math.round((height / 100) * density * 8);
  for (let i = 0; i < lines; i++) {
    const y0 = random() * height;
    const amplitude = 2 + random() * 10;
    const wavelength = 300 + random() * 900;
    const phase = random() * Math.PI * 2;
    ctx.globalAlpha = 0.04 + random() * 0.18;
    ctx.strokeStyle = random() < 0.75 ? dark : light;
    ctx.lineWidth = 0.6 + random() * 2.2;
    ctx.beginPath();
    for (let x = -10; x <= width + 10; x += 24) {
      const y =
        y0 +
        amplitude * Math.sin((x / wavelength) * Math.PI * 2 + phase) +
        2 * Math.sin(x / 37 + i);
      if (x === -10) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // A few knots.
  for (let k = 0; k < 2; k++) {
    const x = random() * width;
    const y = random() * height;
    for (let r = 26; r > 2; r -= 3) {
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = dark;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 2.4, r, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Pores: tiny dark flecks.
  ctx.fillStyle = dark;
  for (let i = 0; i < (width * height) / 900; i++) {
    ctx.globalAlpha = 0.1 + random() * 0.15;
    ctx.fillRect(random() * width, random() * height, 2 + random() * 5, 1);
  }

  ctx.globalAlpha = 1;
  paint?.(ctx);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

// A soft round shadow, dark in the middle and fading out.
export function blobTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(0,0,0,0.85)");
  gradient.addColorStop(0.35, "rgba(0,0,0,0.45)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new CanvasTexture(canvas);
}

// A soft coloured pool of light, for under the box.
export function glowTexture(color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, "transparent");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
