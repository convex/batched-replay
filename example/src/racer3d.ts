// Helpers for the racer's 3D view: the track as geometry, and textures
// painted on a canvas, so nothing is downloaded.
import * as THREE from "three";
import {
  BEND,
  HEIGHT,
  LAP_LENGTH,
  LEFT,
  LINE_X,
  MID_Y,
  RADIUS,
  STRAIGHT,
  WIDTH,
  trackPoint,
} from "./racerTrack";

// The cameras, as named in the URL (&camera=finish) and on the HUD.
export const CAMERAS = { tv: "TV", chase: "Chase", finish: "Finish" } as const;
export type CameraName = keyof typeof CAMERAS;

// The 2D world lies on the ground, centred on the origin: x stays x, and the
// 2D y (down the screen) runs along z, towards the TV camera. 1 unit is 1 px.
export const worldX = (x: number) => x - WIDTH / 2;
export const worldZ = (y: number) => y - HEIGHT / 2;
// A 2D heading becomes a turn about the vertical axis.
export const heading = (angle: number) => -angle;

// Where the bends start and end, in px from the start/finish line.
const toFirstBend = STRAIGHT - (LINE_X - LEFT);
export const BENDS: [number, number][] = [
  [toFirstBend, toFirstBend + BEND],
  [toFirstBend + BEND + STRAIGHT, toFirstBend + 2 * BEND + STRAIGHT],
];

// A point `side` px off the middle of the track (positive is the inside,
// like autodrive's lanes), `distance` px on from the line.
export function trackOffset(distance: number, side: number) {
  const { x, y, angle } = trackPoint(
    ((distance % LAP_LENGTH) + LAP_LENGTH) % LAP_LENGTH,
  );
  return {
    x: worldX(x - Math.sin(angle) * side),
    z: worldZ(y + Math.cos(angle) * side),
    angle,
  };
}

// Distance from a world point to the middle of the track.
export function fromTrack(x: number, z: number) {
  const px = x + WIDTH / 2;
  const py = z + HEIGHT / 2;
  const cx = Math.min(Math.max(px, LEFT), LEFT + STRAIGHT);
  return Math.abs(Math.hypot(px - cx, py - MID_Y) - RADIUS);
}

// Whether a world point is inside the loop of the track.
export function inField(x: number, z: number) {
  const px = x + WIDTH / 2;
  const cx = Math.min(Math.max(px, LEFT), LEFT + STRAIGHT);
  return Math.hypot(px - cx, z + HEIGHT / 2 - MID_Y) < RADIUS;
}

// A flat strip following the track, between two offsets from the middle,
// facing up. u runs along the track in px, v across it in px.
export function ribbon(
  from: number,
  to: number,
  inner: number,
  outer: number,
  y = 0,
  step = 8,
) {
  const count = Math.max(2, Math.ceil((to - from) / step) + 1);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    const d = from + ((to - from) * i) / (count - 1);
    for (const side of [inner, outer]) {
      const p = trackOffset(d, side);
      positions.push(p.x, y, p.z);
      uvs.push(d - from, side);
    }
    if (i > 0) {
      const a = (i - 1) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Face the sky, whichever way round the strip was built.
  if (geometry.getAttribute("normal").getY(0) < 0) {
    for (let i = 0; i < indices.length; i += 3) {
      [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
    }
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
  }
  return geometry;
}

// The same, but going all the way round.
export const lapRibbon = (inner: number, outer: number, y = 0) =>
  ribbon(0, LAP_LENGTH, inner, outer, y);

// A small seeded random generator, so the scenery is the same every time.
export function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// colorFor gives "hsl(210 80% 60%)", which THREE.Color won't parse.
export function toColor(css: string) {
  // Any other CSS colour, such as one from the URL, is read the same way:
  // as the numbers it says, untouched by colour management.
  if (!css.startsWith("hsl")) {
    return new THREE.Color().setStyle(css, THREE.LinearSRGBColorSpace);
  }
  const [h, s, l] = (css.match(/[\d.]+/g) ?? ["0", "0", "50"]).map(Number);
  return new THREE.Color().setHSL(h / 360, s / 100, l / 100);
}

function canvasTexture(
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
  { color = true, repeat = true } = {},
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext("2d")!);
  const texture = new THREE.CanvasTexture(canvas);
  if (color) texture.colorSpace = THREE.SRGBColorSpace;
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

// Fine, low-contrast grain for the asphalt, so it reads as smooth tarmac.
// It's multiplied by the asphalt colour.
export function asphaltTexture() {
  const rand = random(7);
  return canvasTexture(512, 512, (ctx) => {
    ctx.fillStyle = "#a6a6a6";
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 60000; i++) {
      const v = 150 + rand() * 40;
      ctx.fillStyle = `rgb(${v},${v},${v + 3})`;
      ctx.fillRect(rand() * 512, rand() * 512, 1, 1);
    }
    // A few lighter flecks of stone in the mix.
    for (let i = 0; i < 1500; i++) {
      const v = 190 + rand() * 30;
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(rand() * 512, rand() * 512, 1, 1);
    }
  });
}

// Mown stripes and soft patches. It's multiplied by the grass colour.
export function grassTexture() {
  const rand = random(3);
  return canvasTexture(512, 512, (ctx) => {
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? "#e6e6e6" : "#ffffff";
      ctx.fillRect(i * 64, 0, 64, 512);
    }
    for (let i = 0; i < 2500; i++) {
      const v = 200 + rand() * 55;
      ctx.fillStyle = `rgba(${v * 0.9},${v},${v * 0.85},0.35)`;
      ctx.fillRect(rand() * 512, rand() * 512, 2, 2 + rand() * 3);
    }
  });
}

// Red and white blocks, one pair every 48 px along the track.
export function kerbTexture() {
  return canvasTexture(64, 8, (ctx) => {
    ctx.fillStyle = "#EE342F";
    ctx.fillRect(0, 0, 32, 8);
    ctx.fillStyle = "#d9d6cf";
    ctx.fillRect(32, 0, 32, 8);
  });
}

export function chequerTexture(columns: number, rows: number) {
  const texture = canvasTexture(
    columns * 16,
    rows * 16,
    (ctx) => {
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < columns; col++) {
          ctx.fillStyle = (row + col) % 2 ? "#141418" : "#dcdcdc";
          ctx.fillRect(col * 16, row * 16, 16, 16);
        }
      }
    },
    { repeat: false },
  );
  texture.magFilter = THREE.NearestFilter;
  return texture;
}

// A banner in Convex colours, `aspect` times as wide as it is tall, with
// the words repeated along it in the system font.
export function bannerTexture(words: string, aspect: number) {
  const height = 128;
  const width = Math.min(4096, Math.round(height * aspect));
  return canvasTexture(
    width,
    height,
    (ctx) => {
      ctx.fillStyle = "#8D2676";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#F3B01C";
      ctx.fillRect(0, 0, width, 12);
      ctx.fillStyle = "#EE342F";
      ctx.fillRect(0, height - 12, width, 12);
      ctx.fillStyle = "#ffffff";
      ctx.font = "800 70px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const every = Math.max(ctx.measureText(words).width * 2.2, width / 3);
      // Never one in the very middle, where the gantry post stands.
      const fit = Math.max(1, Math.floor(width / every));
      const count = fit > 1 ? fit - (fit % 2) : fit;
      for (let i = 0; i < count; i++) {
        ctx.fillText(words, ((i + 0.5) * width) / count, height / 2 + 3);
      }
    },
    { repeat: false },
  );
}
