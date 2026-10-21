// The 3D view for the cursors demo: a glossy stage, a glossy arrow for each
// cursor, and a fading trail behind everyone else's. Cursors.tsx decides
// where each cursor is; this only draws them, and turns the mouse into a
// point on the shared 1440x900 surface.
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import { colorFor } from "./anonymous";
import { FitCamera, PostFX, StudioEnvironment } from "./CursorsDrawingLook";
import {
  paintTexture,
  pointOnPlane,
  threeColor,
} from "./cursorsDrawingHelpers";
import "./cursors-drawing.css";

type Point = { x: number; y: number };

// The shared surface, in the same pixels every window sends.
const SURFACE = { width: 1440, height: 900 };
// One world unit is 100 surface pixels, centred on the origin.
const SCALE = 1 / 100;
const W = SURFACE.width * SCALE;
const H = SURFACE.height * SCALE;
const toWorldX = (x: number) => (x - SURFACE.width / 2) * SCALE;
const toWorldZ = (y: number) => (y - SURFACE.height / 2) * SCALE;

const HOVER = 0.16; // how high the arrows float over the stage
const MAX_CURSORS = 256;
const TRAIL_MS = 1200;
const MAX_TRAIL = 16384;
const TAG_LIMIT = 12; // more cursors than this and the name tags go

type Props = {
  me: string;
  mine: Point;
  cursors: Map<string, Point>;
  trails: boolean;
  onMove: (point: Point) => void;
};

export default function CursorsScene(props: Props) {
  // The frame loop reads the newest props from here.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const tagsRef = useRef<HTMLDivElement>(null);
  const others = [...props.cursors.keys()];
  const tagged = others.length <= TAG_LIMIT ? others : [];
  return (
    <div className="scene3d cursors3d">
      <Canvas
        className="scene3d-canvas"
        shadows
        dpr={[1, 2]}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        camera={{ fov: 30, near: 0.5, far: 200, manual: true }}
      >
        <color attach="background" args={["#090b14"]} />
        <FitCamera {...FIT} />
        <Lights />
        <StudioEnvironment intensity={0.7} />
        <Stage />
        <Arrows latestRef={latest} />
        <Trails latestRef={latest} />
        <TagProjector latestRef={latest} tagsRef={tagsRef} />
        <PointerToSurface latestRef={latest} />
        <PostFX bloomThreshold={0.7} bloom={0.7} />
      </Canvas>
      <div className="tags" ref={tagsRef}>
        {props.mine.x >= 0 && (
          <Tag stream={props.me} name="You" color={colorFor(props.me)} />
        )}
        {tagged.map((stream) => (
          <Tag
            key={stream}
            stream={stream}
            name={stream}
            color={colorFor(stream)}
          />
        ))}
      </div>
    </div>
  );
}

const CORNERS = [
  new THREE.Vector3(-W / 2 - 0.3, 0, -H / 2 - 0.3),
  new THREE.Vector3(W / 2 + 0.3, 0, -H / 2 - 0.3),
  new THREE.Vector3(-W / 2 - 0.3, 0, H / 2 + 0.3),
  new THREE.Vector3(W / 2 + 0.3, 0, H / 2 + 0.3),
];
// Seen from a little lower, for depth, and framed below the HUD so no part
// of the stage hides behind it. A short window only keeps clear of the nav.
const HUD_BOTTOM = 312;
const FIT = {
  target: [0, 0, 0.15] as [number, number, number],
  from: [0, 1, 0.8] as [number, number, number],
  points: CORNERS,
  box: ({ height }: { height: number }) => [
    -0.97,
    0.97,
    -0.9,
    1 - (2 * (height >= 640 ? HUD_BOTTOM : 56)) / height,
  ],
};

type Latest = { current: Props };

function Tag(props: { stream: string; name: string; color: string }) {
  return (
    <div className="tag" data-tag={props.stream}>
      <i style={{ background: props.color }} />
      {props.name}
    </div>
  );
}

function Lights() {
  return (
    <>
      <hemisphereLight args={["#b9c4ff", "#1a0f1c", 0.35]} />
      <directionalLight
        color="#ffd7a6"
        intensity={2.6}
        position={[-7, 12, 7]}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-10}
        shadow-camera-right={10}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
        shadow-camera-near={1}
        shadow-camera-far={40}
      />
      <directionalLight color="#7d93ff" intensity={1.6} position={[8, 5, -9]} />
      {/* Low and off the stage, so they wash its edges without a hot spot. */}
      <pointLight
        color="#F3B01C"
        intensity={10}
        distance={12}
        decay={1.6}
        position={[-8.5, 1.2, 5.5]}
      />
      <pointLight
        color="#8D2676"
        intensity={12}
        distance={13}
        decay={1.6}
        position={[9, 1.2, -5.5]}
      />
    </>
  );
}

// A soft overhead spotlight makes a pool of light on the middle of the
// stage, falling off to its edges. A real light would be worked out again for
// every pixel of every frame, so instead its light on the stage and the floor
// is baked once into a light map, the same way three.js would light them.
const SPOT = {
  position: new THREE.Vector3(-1.5, 11, 3),
  target: new THREE.Vector3(0.4, 0, 0.6),
  color: new THREE.Color("#c9d2ff"),
  intensity: 70,
  distance: 30,
  decay: 1.5,
  angle: 0.55,
  penumbra: 1,
};

// The spotlight's light on a flat, upward-facing width x depth rectangle at
// height y, centred on the origin, as a light map and its intensity.
function spotLightMap(width: number, depth: number, y: number, size = 256) {
  const { position, target, color, intensity, distance, decay } = SPOT;
  const axis = target.clone().sub(position).normalize();
  const cone = Math.cos(SPOT.angle);
  const inner = Math.cos(SPOT.angle * (1 - SPOT.penumbra));
  const light = new Float32Array(size * size);
  let peak = 0;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // Canvas rows run from the back of the rectangle to the front.
      const dx = ((i + 0.5) / size - 0.5) * width - position.x;
      const dy = y - position.y;
      const dz = ((j + 0.5) / size - 0.5) * depth - position.z;
      const d = Math.max(Math.hypot(dx, dy, dz), 1e-3);
      const along = (dx * axis.x + dy * axis.y + dz * axis.z) / d;
      const soft = Math.max(inner - cone, 1e-4);
      const t = Math.min(1, Math.max(0, (along - cone) / soft));
      const edge = 1 - Math.min(1, (d / distance) ** 4);
      const falloff = (edge * edge) / Math.max(d ** decay, 0.01);
      const facing = Math.max(0, -dy / d);
      const value = intensity * t * t * (3 - 2 * t) * falloff * facing;
      light[j * size + i] = value;
      peak = Math.max(peak, value);
    }
  }
  // Stored as sRGB, for smooth steps in the dim edges of the pool.
  const encode = (v: number) =>
    Math.round(
      255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055),
    );
  const map = paintTexture(size, (ctx) => {
    const image = ctx.createImageData(size, size);
    for (let k = 0; k < size * size; k++) {
      const v = peak > 0 ? light[k] / peak : 0;
      image.data[k * 4] = encode(v * color.r);
      image.data[k * 4 + 1] = encode(v * color.g);
      image.data[k * 4 + 2] = encode(v * color.b);
      image.data[k * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  });
  return { map, intensity: peak };
}

// A dark glossy slab with a faint grid, lit corner brackets in Convex
// yellow, and a soft glow on the floor around it.
function Stage() {
  const { grid, floor, gridLight, floorLight } = useMemo(
    () => ({
      gridLight: spotLightMap(W, H, 0.002),
      floorLight: spotLightMap(60, 40, -0.32),
      grid: paintTexture(2048, (ctx, size) => {
        const sx = size / SURFACE.width;
        const sy = size / SURFACE.height;
        const glow = ctx.createRadialGradient(
          size / 2,
          size / 2,
          0,
          size / 2,
          size / 2,
          size * 0.75,
        );
        glow.addColorStop(0, "#1e2440");
        glow.addColorStop(0.55, "#141830");
        glow.addColorStop(1, "#090b15");
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, size, size);
        // Fine lines every 40 px, stronger ones every 160 px.
        for (const [step, color, width] of [
          [40, "rgba(150,165,230,0.07)", 1.5],
          [160, "rgba(170,185,255,0.16)", 2.5],
        ] as const) {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          for (let x = step; x < SURFACE.width; x += step) {
            ctx.moveTo(x * sx, 0);
            ctx.lineTo(x * sx, size);
          }
          for (let y = step; y < SURFACE.height; y += step) {
            ctx.moveTo(0, y * sy);
            ctx.lineTo(size, y * sy);
          }
          ctx.stroke();
        }
        // Small crosses where the strong lines meet.
        ctx.strokeStyle = "rgba(200,210,255,0.28)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = 160; x < SURFACE.width; x += 160) {
          for (let y = 160; y < SURFACE.height; y += 160) {
            ctx.moveTo((x - 6) * sx, y * sy);
            ctx.lineTo((x + 6) * sx, y * sy);
            ctx.moveTo(x * sx, (y - 6) * sy);
            ctx.lineTo(x * sx, (y + 6) * sy);
          }
        }
        ctx.stroke();
      }),
      floor: paintTexture(1024, (ctx, size) => {
        const glow = ctx.createRadialGradient(
          size / 2,
          size / 2,
          0,
          size / 2,
          size / 2,
          size / 2,
        );
        glow.addColorStop(0, "#232842");
        glow.addColorStop(0.35, "#141729");
        glow.addColorStop(1, "#06070c");
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, size, size);
        // Faint pools of Convex yellow and purple off two corners of the
        // stage, where the low lights sit. The floor is 60x40 world units.
        for (const [x, z, color] of [
          [-8.5, 5.5, "rgba(243,176,28,0.16)"],
          [9, -5.5, "rgba(141,38,118,0.28)"],
        ] as const) {
          const cx = ((x + 30) / 60) * size;
          const cy = ((z + 20) / 40) * size;
          const pool = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.12);
          pool.addColorStop(0, color);
          pool.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = pool;
          ctx.fillRect(0, 0, size, size);
        }
      }),
    }),
    [],
  );
  const bracket = 0.9;
  const edge = 0.035;
  // Drawn front to back, top first, so what's hidden under it is skipped
  // rather than shaded and then covered.
  return (
    <group>
      <mesh
        rotation-x={-Math.PI / 2}
        position-y={-0.32}
        receiveShadow
        renderOrder={-1}
      >
        <planeGeometry args={[60, 40]} />
        <meshStandardMaterial
          map={floor}
          lightMap={floorLight.map}
          lightMapIntensity={floorLight.intensity}
          roughness={0.85}
          metalness={0.1}
        />
      </mesh>
      <RoundedBox
        args={[W + 0.9, 0.3, H + 0.9]}
        radius={0.12}
        smoothness={4}
        position-y={-0.155}
        receiveShadow
        castShadow
        renderOrder={-2}
      >
        <meshPhysicalMaterial
          color="#11131f"
          roughness={0.3}
          metalness={0.2}
          clearcoat={1}
          clearcoatRoughness={0.18}
        />
      </RoundedBox>
      <mesh
        rotation-x={-Math.PI / 2}
        position-y={0.002}
        receiveShadow
        renderOrder={-3}
      >
        <planeGeometry args={[W, H]} />
        <meshPhysicalMaterial
          map={grid}
          lightMap={gridLight.map}
          lightMapIntensity={gridLight.intensity}
          roughness={0.3}
          metalness={0.2}
          clearcoat={1}
          clearcoatRoughness={0.22}
          envMapIntensity={0.85}
        />
      </mesh>
      {/* Lit corner brackets and a faint border. */}
      {[
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ].map(([sx, sz]) => (
        <group
          key={`${sx}${sz}`}
          position={[(sx * W) / 2, 0.012, (sz * H) / 2]}
        >
          <mesh position={[(-sx * bracket) / 2, 0, 0]}>
            <boxGeometry args={[bracket, 0.02, edge]} />
            <meshBasicMaterial color={[2.4, 1.5, 0.3]} toneMapped={false} />
          </mesh>
          <mesh position={[0, 0, (-sz * bracket) / 2]}>
            <boxGeometry args={[edge, 0.02, bracket]} />
            <meshBasicMaterial color={[2.4, 1.5, 0.3]} toneMapped={false} />
          </mesh>
        </group>
      ))}
      {[
        [0, -H / 2, W, 0.012],
        [0, H / 2, W, 0.012],
        [-W / 2, 0, 0.012, H],
        [W / 2, 0, 0.012, H],
      ].map(([x, z, w, d]) => (
        <mesh key={`${x},${z}`} position={[x, 0.008, z]}>
          <boxGeometry args={[w, 0.01, d]} />
          <meshBasicMaterial color="#6a3a8c" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

// A classic pointer arrow, extruded and bevelled, with its tip at the
// origin, lying on the XZ plane and pointing up the screen. The outline is
// the same arrow, flatter and fatter, for the white rim round it.
function arrowGeometry(outline = false) {
  const points = [
    [0, 0],
    [0, -16],
    [4, -12.4],
    [6.9, -19],
    [9.7, -17.8],
    [6.9, -11.5],
    [11.7, -11.5],
  ];
  const s = 0.044;
  const shape = new THREE.Shape(
    points.map(([x, y]) => new THREE.Vector2(x * s, y * s)),
  );
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: outline ? 0.04 : 0.06,
    bevelEnabled: true,
    bevelThickness: outline ? 0.02 : 0.035,
    bevelSize: outline ? 0.085 : 0.03,
    bevelSegments: outline ? 3 : 5,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, outline ? 0 : 0.035, 0);
  geometry.computeVertexNormals();
  return geometry;
}

function glowTexture() {
  return paintTexture(128, (ctx, size) => {
    const g = ctx.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  });
}

// Per cursor: its colour, a phase for the idle bob, and how fast it's moving
// for a little lean into the motion.
type Motion = {
  color: THREE.Color;
  phase: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
};

function phaseFor(stream: string) {
  let hash = 0;
  for (const ch of stream) hash = (hash * 17 + ch.charCodeAt(0)) % 997;
  return (hash / 997) * Math.PI * 2;
}

// Every cursor, yours included, as one instanced mesh of glossy arrows, plus
// one of soft glows on the stage beneath them.
function Arrows({ latestRef }: { latestRef: Latest }) {
  const arrows = useRef<THREE.InstancedMesh>(null);
  const rims = useRef<THREE.InstancedMesh>(null);
  const glows = useRef<THREE.InstancedMesh>(null);
  const { geometry, rimGeometry, glowMap } = useMemo(
    () => ({
      geometry: arrowGeometry(),
      rimGeometry: arrowGeometry(true),
      glowMap: glowTexture(),
    }),
    [],
  );
  const motionsRef = useRef(new Map<string, Motion>());

  useFrame((state, delta) => {
    const mesh = arrows.current;
    const rim = rims.current;
    const glow = glows.current;
    if (!mesh || !rim || !glow) return;
    const { me, mine, cursors } = latestRef.current;
    const t = state.clock.elapsedTime;
    const dt = Math.max(delta, 1 / 240);
    const { matrix, position, quaternion, euler, scale, glowColor } = scratch;
    const motions = motionsRef.current;
    let n = 0;
    const place = (stream: string, point: Point, local: boolean) => {
      if (n >= MAX_CURSORS) return;
      const x = toWorldX(point.x);
      const z = toWorldZ(point.y);
      let motion = motions.get(stream);
      if (!motion) {
        motion = {
          color: threeColor(colorFor(stream)),
          phase: phaseFor(stream),
          x,
          z,
          vx: 0,
          vz: 0,
        };
        motions.set(stream, motion);
      }
      const k = Math.min(1, dt * 10);
      motion.vx += ((x - motion.x) / dt - motion.vx) * k;
      motion.vz += ((z - motion.z) / dt - motion.vz) * k;
      motion.x = x;
      motion.z = z;
      // Your own arrow sits still under the mouse; the others bob a little.
      const bob = local ? 0 : Math.sin(t * 2.2 + motion.phase) * 0.035;
      position.set(x, HOVER + bob, z);
      euler.set(-0.32 + lean(motion.vz), 0, -lean(motion.vx));
      quaternion.setFromEuler(euler);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(n, matrix);
      mesh.setColorAt(n, motion.color);
      rim.setMatrixAt(n, matrix);
      position.set(x + 0.2, 0.006, z + 0.3);
      matrix.compose(position, GLOW_TURN, GLOW_SIZE);
      glow.setMatrixAt(n, matrix);
      glow.setColorAt(n, glowColor.copy(motion.color).multiplyScalar(0.5));
      n++;
    };
    // Everyone else's, then yours, which is drawn with no delay.
    cursors.forEach((point, stream) => place(stream, point, false));
    if (mine.x >= 0) place(me, mine, true);
    mesh.count = n;
    rim.count = n;
    glow.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    rim.instanceMatrix.needsUpdate = true;
    glow.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
    if (motions.size > MAX_CURSORS * 2) motions.clear();
  });

  return (
    <>
      {/* Only the rim casts a shadow: it's bigger than the arrow, so the
          arrow's shadow would fall inside its own. */}
      <instancedMesh
        ref={arrows}
        args={[geometry, undefined, MAX_CURSORS]}
        frustumCulled={false}
      >
        <meshPhysicalMaterial
          roughness={0.2}
          metalness={0.05}
          clearcoat={1}
          clearcoatRoughness={0.06}
        />
      </instancedMesh>
      <instancedMesh
        ref={rims}
        args={[rimGeometry, undefined, MAX_CURSORS]}
        castShadow
        frustumCulled={false}
      >
        <meshStandardMaterial
          color="#f4f5fa"
          emissive="#ffffff"
          emissiveIntensity={0.18}
          roughness={0.3}
        />
      </instancedMesh>
      <instancedMesh
        ref={glows}
        args={[undefined, undefined, MAX_CURSORS]}
        frustumCulled={false}
      >
        {/* A disc, not a square: the glow fades out at its edge, so the
            corners would be drawn for nothing. */}
        <circleGeometry args={[0.5, 32]} />
        <meshBasicMaterial
          map={glowMap}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </instancedMesh>
    </>
  );
}
// Reused every frame, rather than allocated.
const scratch = {
  matrix: new THREE.Matrix4(),
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  euler: new THREE.Euler(),
  scale: new THREE.Vector3(1, 1, 1),
  glowColor: new THREE.Color(),
};
const GLOW_TURN = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(-Math.PI / 2, 0, 0),
);
const GLOW_SIZE = new THREE.Vector3(1.6, 1.6, 1);
const lean = (v: number) => Math.max(-0.2, Math.min(0.2, v * 0.04));

// One trail point a frame for each remote cursor. A cursor that sits still
// keeps refreshing its last point instead of adding more. A point joins the
// one before it with a line only if the cursor was moving on the frame
// before too, or barely moved: so a cursor that jumps leaves scattered dots,
// and one that glides leaves a line.
type TrailPoint = { x: number; z: number; t: number; joined: boolean };
type Trail = { points: TrailPoint[]; color: THREE.Color; moving: boolean };

const trailVertex = /* glsl */ `
  attribute vec3 aSeg;   // length, radius, alpha
  attribute vec3 aColor;
  varying vec2 vLocal;
  varying vec3 vSeg;
  varying vec3 vColor;
  void main() {
    float len = aSeg.x;
    float r = aSeg.y;
    vLocal = vec2((uv.x - 0.5) * (len + 2.0 * r), (uv.y - 0.5) * 2.0 * r);
    vSeg = aSeg;
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;
const trailFragment = /* glsl */ `
  varying vec2 vLocal;
  varying vec3 vSeg;
  varying vec3 vColor;
  void main() {
    float r = vSeg.y;
    float d = length(vec2(max(abs(vLocal.x) - vSeg.x * 0.5, 0.0), vLocal.y));
    float core = smoothstep(r, r * 0.35, d);
    // A hot centre line, so the trail reads as light rather than paint.
    float hot = smoothstep(r * 0.45, 0.0, d);
    float a = core * vSeg.z;
    if (a <= 0.002) discard;
    // Premultiplied: with MAX blending, overlapping pieces don't stack up.
    gl_FragColor = vec4((vColor * 2.8 + hot * 0.9) * a, a);
  }
`;

function Trails({ latestRef }: { latestRef: Latest }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const trailsRef = useRef(new Map<string, Trail>());
  // Points that have faded, kept to be reused rather than allocated anew.
  const spareRef = useRef<TrailPoint[]>([]);
  const { geometry, material } = useMemo(() => {
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const seg = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_TRAIL * 3),
      3,
    );
    const color = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_TRAIL * 3),
      3,
    );
    seg.setUsage(THREE.DynamicDrawUsage);
    color.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aSeg", seg);
    geometry.setAttribute("aColor", color);
    const material = new THREE.ShaderMaterial({
      vertexShader: trailVertex,
      fragmentShader: trailFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
    });
    return { geometry, material };
  }, []);

  useFrame(() => {
    const instanced = mesh.current;
    if (!instanced) return;
    const { cursors, trails: on } = latestRef.current;
    const now = performance.now();
    const trails = trailsRef.current;
    const spare = spareRef.current;
    if (!on) {
      trails.clear();
      instanced.count = 0;
      return;
    }
    // Record where every remote cursor is drawn this frame.
    for (const [stream, point] of cursors) {
      const x = toWorldX(point.x);
      const z = toWorldZ(point.y);
      let trail = trails.get(stream);
      if (!trail) {
        trail = {
          points: [],
          color: threeColor(colorFor(stream)),
          moving: false,
        };
        trails.set(stream, trail);
      }
      const last = trail.points.at(-1);
      if (last && last.x === x && last.z === z) {
        last.t = now;
        trail.moving = false;
        continue;
      }
      const step = last ? Math.hypot(x - last.x, z - last.z) : 0;
      const added = spare.pop() ?? { x, z, t: now, joined: false };
      added.x = x;
      added.z = z;
      added.t = now;
      added.joined = !!last && (trail.moving || step < 0.3);
      trail.points.push(added);
      trail.moving = true;
    }
    // Draw each point as a capsule back to the one before it, or a dot,
    // shrinking and fading with age.
    const seg = instanced.geometry.getAttribute("aSeg");
    const color = instanced.geometry.getAttribute("aColor");
    const segs = seg.array as Float32Array;
    const colors = color.array as Float32Array;
    const { matrix } = scratch;
    const m = matrix.elements;
    let n = 0;
    for (const [stream, trail] of trails) {
      const points = trail.points;
      while (points.length && now - points[0].t > TRAIL_MS) {
        spare.push(points.shift()!);
      }
      if (!points.length) {
        trails.delete(stream);
        continue;
      }
      for (let i = 0; i < points.length && n < MAX_TRAIL; i++) {
        const p = points[i];
        const from = p.joined && i > 0 ? points[i - 1] : p;
        const life = 1 - (now - p.t) / TRAIL_MS;
        const r = 0.04 + 0.05 * life;
        const dx = p.x - from.x;
        const dz = p.z - from.z;
        const len = Math.hypot(dx, dz);
        const c = len > 0 ? dx / len : 1;
        const s = len > 0 ? -dz / len : 0;
        const sx = len + 2 * r;
        const sz = 2 * r;
        // Turn about y so local x runs along the segment, then scale.
        m[0] = c * sx;
        m[1] = 0;
        m[2] = -s * sx;
        m[3] = 0;
        m[4] = 0;
        m[5] = 1;
        m[6] = 0;
        m[7] = 0;
        m[8] = s * sz;
        m[9] = 0;
        m[10] = c * sz;
        m[11] = 0;
        m[12] = (p.x + from.x) / 2;
        m[13] = 0.01;
        m[14] = (p.z + from.z) / 2;
        m[15] = 1;
        instanced.setMatrixAt(n, matrix);
        segs[n * 3] = len;
        segs[n * 3 + 1] = r;
        segs[n * 3 + 2] = life ** 1.25;
        colors[n * 3] = trail.color.r;
        colors[n * 3 + 1] = trail.color.g;
        colors[n * 3 + 2] = trail.color.b;
        n++;
      }
    }
    instanced.count = n;
    instanced.instanceMatrix.needsUpdate = true;
    seg.needsUpdate = true;
    color.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, material, MAX_TRAIL]}
      frustumCulled={false}
      renderOrder={1}
    />
  );
}

// Keeps each name tag pinned beside its arrow.
function TagProjector({
  latestRef,
  tagsRef,
}: {
  latestRef: Latest;
  tagsRef: { current: HTMLDivElement | null };
}) {
  useFrame(({ camera, size }) => {
    const v = scratch.position;
    const container = tagsRef.current;
    if (!container) return;
    const { me, mine, cursors } = latestRef.current;
    for (const el of container.children) {
      if (!(el instanceof HTMLElement)) continue;
      const stream = el.dataset.tag!;
      const point = stream === me ? mine : cursors.get(stream);
      if (!point) continue;
      v.set(toWorldX(point.x) + 0.62, HOVER, toWorldZ(point.y) + 0.72);
      v.project(camera);
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((1 - v.y) / 2) * size.height;
      el.style.setProperty(
        "transform",
        `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`,
      );
    }
  });
  return null;
}

// Turns the mouse into a point on the shared surface: where its ray meets
// the plane the arrows float on, so your arrow's tip sits under the pointer.
function PointerToSurface({ latestRef }: { latestRef: Latest }) {
  const camera = useThree((s) => s.camera);
  const element = useThree((s) => s.gl.domElement);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const hit = pointOnPlane(camera, element, e.clientX, e.clientY, HOVER);
      if (!hit) return;
      const clamp = (n: number, max: number) =>
        Math.round(Math.min(max, Math.max(0, n)));
      latestRef.current.onMove({
        x: clamp(hit.x / SCALE + SURFACE.width / 2, SURFACE.width),
        y: clamp(hit.z / SCALE + SURFACE.height / 2, SURFACE.height),
      });
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [camera, element, latestRef]);
  return null;
}
