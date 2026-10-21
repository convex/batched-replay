// The 3D view for the marble demo: a wooden labyrinth in a box with two
// knobs, tilting with the replayed tilt. It only draws: Marble.tsx runs the
// physics and writes where the ball is into `view` every frame.
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import {
  Bloom,
  EffectComposer,
  ToneMapping,
  Vignette,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { blobTexture, glowTexture, seeded, woodTexture } from "./wood";
import "./marble.css";

type Point = { x: number; y: number };
export type MarbleLayout = {
  maze: string[];
  cell: number; // px per maze cell: one world unit
  start: Point;
  goal: Point;
  holes: Point[];
  radius: number;
  holeRadius: number;
};
// What the physics loop shares with the scene, in maze px and ms.
export type MarbleView = {
  ball: Point;
  tilt: { beta: number; gamma: number };
  fall: (Point & { at: number }) | null; // the hole it's dropping into
  fallMs: number;
  spawnedAt: number;
  finishedAt: number;
};

const DEG = Math.PI / 180;
// The board tilts this much of the phone's tilt, like a real labyrinth.
const VISUAL_TILT = 0.3;
const KNOB_TURNS = 7; // the knobs turn this much more than the board
const FLOOR = 0.45; // board thickness
const WALL_H = 0.8;
const FRAME_H = 1.15;
const GAP = 0.7; // between the board and its box
const BOX_T = 1.5;
const BOX_TOP = 0.15;
const BOX_BOTTOM = -3.6;
const HOLE_DEPTH = 2.6;

const YELLOW = "#F3B01C";
const PURPLE = "#8D2676";
const RED = "#EE342F";

function useLayout(layout: MarbleLayout) {
  return useMemo(() => {
    const cols = layout.maze[0].length;
    const rows = layout.maze.length;
    const toWorld = (p: Point) => ({
      x: p.x / layout.cell - cols / 2,
      z: p.y / layout.cell - rows / 2,
    });
    return { cols, rows, toWorld, unit: 1 / layout.cell };
  }, [layout]);
}

// Wall cells, merged greedily into rectangles, then into one rounded mesh.
function wallGeometry(maze: string[], frame: boolean) {
  const rows = maze.length;
  const cols = maze[0].length;
  const random = seeded(frame ? 7 : 3);
  const pieces: THREE.BufferGeometry[] = [];
  const add = (c: number, r: number, w: number, h: number, height: number) => {
    const along = w >= h;
    const length = along ? w : h;
    const across = along ? h : w;
    const piece = new RoundedBoxGeometry(length, height, across, 2, 0.09);
    // Grain runs along each piece, and no two pieces match.
    const uv = piece.attributes.uv;
    const du = random();
    const dv = random();
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * (length / 7) + du, uv.getY(i) * 0.18 + dv);
    }
    if (!along) piece.rotateY(Math.PI / 2);
    piece.translate(c + w / 2 - cols / 2, height / 2, r + h / 2 - rows / 2);
    pieces.push(piece);
  };
  if (frame) {
    add(0, 0, cols, 1, FRAME_H);
    add(0, rows - 1, cols, 1, FRAME_H);
    add(0, 1, 1, rows - 2, FRAME_H);
    add(cols - 1, 1, 1, rows - 2, FRAME_H);
  } else {
    const used = maze.map((row) => [...row].map(() => false));
    const free = (c: number, r: number) =>
      r > 0 &&
      r < rows - 1 &&
      c > 0 &&
      c < cols - 1 &&
      maze[r][c] === "#" &&
      !used[r][c];
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        if (!free(c, r)) continue;
        let w = 1;
        while (free(c + w, r)) w++;
        let h = 1;
        while ([...Array(w).keys()].every((i) => free(c + i, r + h))) h++;
        for (let y = r; y < r + h; y++)
          for (let x = c; x < c + w; x++) used[y][x] = true;
        add(c, r, w, h, WALL_H);
      }
    }
  }
  return mergeGeometries(pieces);
}

// The floor: a slab with the holes cut through it, and the markings painted
// on its wood.
function floorParts(layout: MarbleLayout, cols: number, rows: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-cols / 2, -rows / 2);
  shape.lineTo(cols / 2, -rows / 2);
  shape.lineTo(cols / 2, rows / 2);
  shape.lineTo(-cols / 2, rows / 2);
  shape.closePath();
  const r = layout.holeRadius / layout.cell;
  for (const hole of layout.holes) {
    const path = new THREE.Path();
    const x = hole.x / layout.cell - cols / 2;
    const z = hole.y / layout.cell - rows / 2;
    path.absarc(x, -z, r, 0, Math.PI * 2, true);
    shape.holes.push(path);
  }
  const bevel = 0.04;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: FLOOR - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 40,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -FLOOR + bevel, 0);

  // One texture across the whole board, in maze px.
  const px = 2048 / cols;
  const texture = woodTexture({
    width: 2048,
    height: Math.round(px * rows),
    base: "#d6a86c",
    dark: "#8a5a2b",
    light: "#f2cf98",
    seed: 11,
    paint: (ctx) => {
      const at = (p: Point) => [
        (p.x / layout.cell) * px,
        (p.y / layout.cell) * px,
      ];
      // Scorched rings round the holes.
      for (const hole of layout.holes) {
        const [x, y] = at(hole);
        const g = ctx.createRadialGradient(x, y, r * px, x, y, r * px * 1.9);
        g.addColorStop(0, "rgba(40,18,6,0.55)");
        g.addColorStop(1, "rgba(40,18,6,0)");
        ctx.fillStyle = g;
        ctx.fillRect(x - 2 * r * px, y - 2 * r * px, 4 * r * px, 4 * r * px);
      }
      // Start: a yellow ring.
      const [sx, sy] = at(layout.start);
      ctx.strokeStyle = YELLOW;
      ctx.lineWidth = 0.09 * px;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(sx, sy, 0.62 * px, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = YELLOW;
      ctx.fill();
      // Goal: a red and cream target.
      const [gx, gy] = at(layout.goal);
      ctx.globalAlpha = 0.95;
      for (const [radius, color] of [
        [0.78, RED],
        [0.58, "#f6e6c8"],
        [0.4, RED],
        [0.2, "#f6e6c8"],
      ] as const) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(gx, gy, radius * px, 0, Math.PI * 2);
        ctx.fill();
      }
      // Painted labels, in a dark ink.
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = "#3a2212";
      ctx.font = `800 ${0.62 * px}px system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText("START", sx + 1.1 * px, sy + 0.5 * px);
      ctx.textAlign = "right";
      ctx.fillText("GOAL", gx - 1.1 * px, gy + 0.5 * px);
      ctx.globalAlpha = 1;
    },
  });
  texture.repeat.set(1 / cols, 1 / rows);
  texture.offset.set(0.5, 0.5);
  return { geometry, texture };
}

function Board({
  layout,
  view,
}: {
  layout: MarbleLayout;
  view: RefObject<MarbleView>;
}) {
  const { cols, rows, toWorld } = useLayout(layout);
  const parts = useMemo(() => {
    const floor = floorParts(layout, cols, rows);
    const wallTexture = woodTexture({
      width: 1024,
      height: 512,
      base: "#b8773e",
      dark: "#6e3d17",
      light: "#e0a564",
      seed: 5,
    });
    const frameTexture = woodTexture({
      width: 1024,
      height: 512,
      base: "#6b3f22",
      dark: "#2e1709",
      light: "#9a6338",
      seed: 9,
    });
    return {
      floor,
      walls: wallGeometry(layout.maze, false),
      frame: wallGeometry(layout.maze, true),
      wallTexture,
      frameTexture,
    };
  }, [layout, cols, rows]);

  const board = useRef<THREE.Group>(null);
  const frontKnob = useRef<THREE.Group>(null);
  const sideKnob = useRef<THREE.Group>(null);
  const goalRing = useRef<THREE.MeshStandardMaterial>(null);
  // A springy ease towards the replayed tilt, so the board has some weight.
  const spring = useRef({ x: 0, z: 0, vx: 0, vz: 0 });
  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);
    const s = spring.current;
    const tilt = view.current.tilt;
    const targetX = tilt.beta * DEG * VISUAL_TILT;
    const targetZ = -tilt.gamma * DEG * VISUAL_TILT;
    const stiffness = 140;
    const damping = 2 * Math.sqrt(stiffness) * 0.8;
    s.vx += (stiffness * (targetX - s.x) - damping * s.vx) * dt;
    s.vz += (stiffness * (targetZ - s.z) - damping * s.vz) * dt;
    s.x += s.vx * dt;
    s.z += s.vz * dt;
    board.current?.rotation.set(s.x, 0, s.z);
    frontKnob.current?.rotation.set(0, s.z * KNOB_TURNS, 0);
    sideKnob.current?.rotation.set(0, s.x * KNOB_TURNS, 0);
    if (goalRing.current) {
      const now = performance.now();
      const flash = Math.max(0, 1 - (now - view.current.finishedAt) / 900);
      goalRing.current.emissiveIntensity =
        2.2 + 0.6 * Math.sin(now / 400) + 10 * flash;
    }
  });

  const start = toWorld(layout.start);
  const goal = toWorld(layout.goal);
  const holeR = layout.holeRadius / layout.cell;
  const ix = cols / 2 + GAP;
  const iz = rows / 2 + GAP;
  const wood = {
    roughness: 0.5,
    clearcoat: 0.6,
    clearcoatRoughness: 0.28,
    bumpScale: 1.2,
  };

  return (
    <>
      {/* The box stays still: only the board inside it tilts. */}
      <BoxShell ix={ix} iz={iz} texture={parts.frameTexture} />
      <group position={[0, -1.4, iz + BOX_T]} rotation={[Math.PI / 2, 0, 0]}>
        <group ref={frontKnob}>
          <Knob scale={1.35} />
        </group>
      </group>
      <group position={[ix + BOX_T, -1.4, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <group ref={sideKnob}>
          <Knob scale={1.35} />
        </group>
      </group>

      <group ref={board}>
        <mesh geometry={parts.floor.geometry} receiveShadow castShadow>
          <meshPhysicalMaterial
            map={parts.floor.texture}
            bumpMap={parts.floor.texture}
            {...wood}
          />
        </mesh>
        <mesh geometry={parts.walls} castShadow receiveShadow>
          <meshPhysicalMaterial
            map={parts.wallTexture}
            bumpMap={parts.wallTexture}
            {...wood}
          />
        </mesh>
        <mesh geometry={parts.frame} castShadow receiveShadow>
          <meshPhysicalMaterial
            map={parts.frameTexture}
            bumpMap={parts.frameTexture}
            {...wood}
            clearcoat={0.9}
          />
        </mesh>

        {layout.holes.map((hole, i) => {
          const { x, z } = toWorld(hole);
          return (
            <group key={i} position={[x, 0, z]}>
              <mesh position={[0, -HOLE_DEPTH / 2, 0]}>
                <cylinderGeometry
                  args={[holeR, holeR, HOLE_DEPTH, 40, 1, true]}
                />
                <meshStandardMaterial
                  color="#120a05"
                  roughness={1}
                  side={THREE.BackSide}
                />
              </mesh>
              <mesh position={[0, -HOLE_DEPTH, 0]} rotation-x={-Math.PI / 2}>
                <circleGeometry args={[holeR, 40]} />
                <meshBasicMaterial color="#000" />
              </mesh>
              <mesh rotation-x={Math.PI / 2} position={[0, 0.005, 0]}>
                <torusGeometry args={[holeR + 0.02, 0.045, 12, 48]} />
                <meshStandardMaterial
                  color="#c99a4a"
                  metalness={1}
                  roughness={0.25}
                />
              </mesh>
            </group>
          );
        })}

        <mesh position={[start.x, 0.01, start.z]} rotation-x={Math.PI / 2}>
          <torusGeometry args={[0.62, 0.03, 10, 48]} />
          <meshStandardMaterial
            color={YELLOW}
            emissive={YELLOW}
            emissiveIntensity={2.5}
            toneMapped={false}
          />
        </mesh>
        <mesh position={[goal.x, 0.01, goal.z]} rotation-x={Math.PI / 2}>
          <torusGeometry args={[0.82, 0.04, 10, 48]} />
          <meshStandardMaterial
            ref={goalRing}
            color={PURPLE}
            emissive="#c23aa8"
            emissiveIntensity={2.5}
            toneMapped={false}
          />
        </mesh>
        <pointLight
          position={[goal.x, 0.9, goal.z]}
          color="#d14ab8"
          intensity={6}
          distance={5}
          decay={2}
        />

        <Ball layout={layout} view={view} />
      </group>
    </>
  );
}

function BoxShell({
  ix,
  iz,
  texture,
}: {
  ix: number;
  iz: number;
  texture: THREE.Texture;
}) {
  const geometry = useMemo(() => {
    const h = BOX_TOP - BOX_BOTTOM;
    const y = (BOX_TOP + BOX_BOTTOM) / 2;
    const random = seeded(21);
    const piece = (
      length: number,
      across: number,
      x: number,
      z: number,
      turn: boolean,
    ) => {
      const g = new RoundedBoxGeometry(length, h, across, 3, 0.22);
      const uv = g.attributes.uv;
      const du = random();
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * (length / 9) + du, uv.getY(i) * 0.35);
      }
      if (turn) g.rotateY(Math.PI / 2);
      g.translate(x, y, z);
      return g;
    };
    const outerX = ix + BOX_T;
    return mergeGeometries([
      piece(outerX * 2, BOX_T, 0, iz + BOX_T / 2, false),
      piece(outerX * 2, BOX_T, 0, -iz - BOX_T / 2, false),
      piece(iz * 2, BOX_T, ix + BOX_T / 2, 0, true),
      piece(iz * 2, BOX_T, -ix - BOX_T / 2, 0, true),
      // The bottom of the box, under the board.
      new RoundedBoxGeometry(ix * 2 + 0.4, 0.4, iz * 2 + 0.4, 1, 0.1).translate(
        0,
        BOX_BOTTOM + 0.2,
        0,
      ),
    ]);
  }, [ix, iz]);
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshPhysicalMaterial
        map={texture}
        bumpMap={texture}
        bumpScale={1.2}
        color="#a07a66"
        roughness={0.45}
        clearcoat={1}
        clearcoatRoughness={0.2}
      />
    </mesh>
  );
}

// A black knob with a brass collar and a yellow mark, so you see it turn.
function Knob({ scale = 1 }: { scale?: number }) {
  const geometry = useMemo(() => {
    const profile = [
      [0, 0],
      [0.55, 0],
      [0.55, 0.25],
      [1.05, 0.32],
      [1.18, 0.45],
      [1.18, 0.95],
      [1.06, 1.12],
      [0.4, 1.18],
      [0, 1.18],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    return new THREE.LatheGeometry(profile, 64);
  }, []);
  return (
    <group scale={scale}>
      <mesh geometry={geometry} castShadow>
        <meshPhysicalMaterial
          color="#16161c"
          roughness={0.35}
          clearcoat={1}
          clearcoatRoughness={0.15}
        />
      </mesh>
      <mesh position={[0, 0.12, 0]}>
        <cylinderGeometry args={[0.62, 0.62, 0.24, 40]} />
        <meshStandardMaterial color="#c99a4a" metalness={1} roughness={0.3} />
      </mesh>
      <mesh position={[0, 1.19, 0.6]}>
        <boxGeometry args={[0.16, 0.03, 0.8]} />
        <meshStandardMaterial
          color={YELLOW}
          emissive={YELLOW}
          emissiveIntensity={0.8}
        />
      </mesh>
    </group>
  );
}

function Ball({
  layout,
  view,
}: {
  layout: MarbleLayout;
  view: RefObject<MarbleView>;
}) {
  const { toWorld } = useLayout(layout);
  const radius = layout.radius / layout.cell;
  const ball = useRef<THREE.Mesh>(null);
  const shadow = useRef<THREE.Mesh>(null);
  const shadowMaterial = useRef<THREE.MeshBasicMaterial>(null);
  const blob = useMemo(() => blobTexture(), []);
  useFrame(() => {
    const now = performance.now();
    const { ball: at, fall, fallMs, spawnedAt } = view.current;
    let { x, z } = toWorld(at);
    let y = radius;
    let shade = 1;
    if (fall) {
      // Roll over the edge into the middle of the hole, then drop.
      const t = Math.min(1, (now - fall.at) / fallMs);
      const hole = toWorld(fall);
      const slide = 1 - (1 - Math.min(1, t / 0.35)) ** 3;
      x += (hole.x - x) * slide;
      z += (hole.z - z) * slide;
      y =
        radius - 0.15 * slide - (HOLE_DEPTH + 0.5) * Math.max(0, t - 0.2) ** 2;
      shade = Math.max(0, 1 - t * 4);
    } else {
      // Drop in at the start, with a little bounce.
      const t = Math.min(1, (now - spawnedAt) / 450);
      y += 2.4 * Math.abs(Math.cos(t * Math.PI * 1.5)) * (1 - t) ** 2;
      shade = 0.4 + 0.6 * t;
    }
    ball.current?.position.set(x, y, z);
    shadow.current?.position.set(x, 0.012, z);
    if (shadowMaterial.current) shadowMaterial.current.opacity = 0.75 * shade;
  });
  return (
    <>
      <mesh ref={ball} castShadow>
        <sphereGeometry args={[radius, 64, 48]} />
        <meshStandardMaterial
          color="#eef1f5"
          metalness={1}
          roughness={0.06}
          envMapIntensity={1.4}
        />
      </mesh>
      <mesh ref={shadow} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[radius * 3, radius * 3]} />
        <meshBasicMaterial
          ref={shadowMaterial}
          map={blob}
          transparent
          depthWrite={false}
        />
      </mesh>
    </>
  );
}

// A three-quarter view from the front right, framed to leave room for the
// HUD on the left.
function CameraRig({ cols, rows }: { cols: number; rows: number }) {
  const { camera, size } = useThree();
  useLayoutEffect(() => {
    const perspective = camera as THREE.PerspectiveCamera;
    const hud = size.width > 900 ? 380 : 0;
    const across = size.width - hud;
    const tanHalf = Math.tan((perspective.fov / 2) * DEG);
    const halfWidth = cols / 2 + GAP + BOX_T + 4;
    const halfDepth = rows / 2 + GAP + BOX_T + 2.5;
    const distance = Math.max(
      halfWidth / (tanHalf * (across / size.height)),
      (halfDepth * 1.1) / tanHalf,
    );
    const elevation = 55 * DEG;
    const azimuth = 16 * DEG;
    const target = new THREE.Vector3(0.6, -1.2, 0.6);
    perspective.position.set(
      target.x + distance * Math.sin(azimuth) * Math.cos(elevation),
      target.y + distance * Math.sin(elevation),
      target.z + distance * Math.cos(azimuth) * Math.cos(elevation),
    );
    perspective.lookAt(target);
    perspective.setViewOffset(
      size.width,
      size.height,
      -hud / 2,
      0,
      size.width,
      size.height,
    );
    perspective.updateProjectionMatrix();
  }, [camera, size, cols, rows]);
  return null;
}

function Lights() {
  return (
    <>
      <directionalLight
        position={[-24, 22, 12]}
        color="#ffd7a6"
        intensity={3.4}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-24}
        shadow-camera-right={24}
        shadow-camera-top={18}
        shadow-camera-bottom={-18}
        shadow-camera-near={10}
        shadow-camera-far={80}
        shadow-bias={-0.0003}
        shadow-normalBias={0.03}
        shadow-radius={4}
      />
      <directionalLight
        position={[18, 9, -24]}
        color="#8fb2ff"
        intensity={2.2}
      />
      <hemisphereLight args={["#2a3550", "#120c08", 0.35]} />
      <Environment resolution={256} frames={1}>
        <color attach="background" args={["#56607a"]} />
        {/* Behind the camera: the steel ball's bright face. */}
        <Lightformer
          form="rect"
          color="#f4f1ea"
          intensity={1.6}
          position={[3, 9, 12]}
          scale={[12, 5, 1]}
        />
        <Lightformer
          form="rect"
          color="#ffe1b5"
          intensity={3}
          position={[-8, 10, 6]}
          scale={[14, 7, 1]}
        />
        <Lightformer
          form="ring"
          color="#ffffff"
          intensity={1.2}
          position={[2, 12, -3]}
          scale={5}
        />
        <Lightformer
          form="rect"
          color="#8fb0ff"
          intensity={4}
          position={[12, 3, -10]}
          scale={[14, 1.5, 1]}
        />
        <Lightformer
          form="rect"
          color={PURPLE}
          intensity={4}
          position={[-14, 2, -6]}
          scale={[10, 2, 1]}
        />
        <Lightformer
          form="rect"
          color={YELLOW}
          intensity={1.5}
          position={[6, 1, 12]}
          scale={[8, 0.6, 1]}
        />
        {/* A dim sky, so the steel ball has something bright to show. */}
        <Lightformer
          form="rect"
          color="#c9d6ff"
          intensity={0.5}
          position={[0, 14, -4]}
          scale={[40, 30, 1]}
        />
        <Lightformer
          form="rect"
          color="#1a2236"
          intensity={1}
          position={[0, -8, 0]}
          scale={[30, 30, 1]}
        />
      </Environment>
    </>
  );
}

// Pools of purple and orange light on the table, behind and in front.
function TableGlow() {
  const textures = useMemo(
    () => [glowTexture("#8D267699"), glowTexture("#f37b1c33")],
    [],
  );
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position={[-6, BOX_BOTTOM, -10]}>
        <planeGeometry args={[90, 50]} />
        <meshBasicMaterial
          map={textures[0]}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[10, BOX_BOTTOM, 12]}>
        <planeGeometry args={[60, 30]} />
        <meshBasicMaterial
          map={textures[1]}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </>
  );
}

function MarbleBoard({
  layout,
  view,
}: {
  layout: MarbleLayout;
  view: RefObject<MarbleView>;
}) {
  const cols = layout.maze[0].length;
  const rows = layout.maze.length;
  return (
    <div className="marble-stage">
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ fov: 30, near: 1, far: 300 }}
        gl={{ antialias: false, powerPreference: "high-performance" }}
      >
        <color attach="background" args={["#0a0f1e"]} />
        <fog attach="fog" args={["#0a0f1e", 50, 120]} />
        <CameraRig cols={cols} rows={rows} />
        <Lights />
        <Board layout={layout} view={view} />
        {/* The table the box sits on. */}
        <mesh
          rotation-x={-Math.PI / 2}
          position={[0, BOX_BOTTOM - 0.02, 0]}
          receiveShadow
        >
          <planeGeometry args={[400, 400]} />
          <meshStandardMaterial color="#0f1830" roughness={0.85} />
        </mesh>
        <TableGlow />
        <EffectComposer multisampling={4}>
          <Bloom
            mipmapBlur
            luminanceThreshold={1}
            luminanceSmoothing={0.25}
            intensity={0.6}
          />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
          <Vignette offset={0.28} darkness={0.7} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

// Props never change, so the HUD's re-renders skip the scene.
export default memo(MarbleBoard);
