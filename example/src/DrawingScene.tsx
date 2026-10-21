// The 3D view for the drawing demo: a sheet of paper on a walnut desk, with
// the 2D board canvas (or the timelapse's) as the ink on it, and a marker
// for each pen that's down. Drawing.tsx still does all the drawing on those
// canvases; this shows them, and turns the pointer into board coordinates.
import { useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
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
type Pens = Map<string, Point>;

// The board is 1600x900; one world unit is 100 board pixels.
const WIDTH = 1600;
const HEIGHT = 900;
const SCALE = 1 / 100;
const W = WIDTH * SCALE;
const H = HEIGHT * SCALE;
const toWorldX = (x: number) => (x - WIDTH / 2) * SCALE;
const toWorldZ = (y: number) => (y - HEIGHT / 2) * SCALE;
const PAPER_Y = 0.06; // the top of the top sheet
const MARKERS = 6; // yours, and up to five others drawing at once

type Props = {
  me: string;
  board: RefObject<HTMLCanvasElement | null>;
  timelapse: RefObject<HTMLCanvasElement | null>;
  showTimelapse: boolean;
  // Where each pen is while it's down: yours, and the ones being replayed.
  pens: { mine: Pens; others: Pens };
  onPenDown: (point: Point) => void;
  onPenMove: (point: Point) => void;
  onPenUp: (point: Point) => void;
};
type Latest = { current: Props };
// Where the pointer is over the paper, in board pixels, or null.
type Hover = { current: Point | null };

export default function DrawingScene(props: Props) {
  // The frame loop and event handlers read the newest props from here.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const hover = useRef<Point | null>(null);
  return (
    <div className="scene3d drawing3d">
      <Canvas
        className="scene3d-canvas"
        shadows
        dpr={[1, 2]}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        camera={{ fov: 30, near: 0.5, far: 200, manual: true }}
      >
        <color attach="background" args={["#0d0a0a"]} />
        <FitCamera {...FIT} />
        <Lights />
        <StudioEnvironment intensity={0.45} />
        <Desk />
        <Paper latestRef={latest} />
        <DeskThings />
        <Markers latestRef={latest} hoverRef={hover} />
        <PaperInput latestRef={latest} hoverRef={hover} />
        <PostFX bloomThreshold={1.1} bloom={0.35} vignette={0.72} />
      </Canvas>
    </div>
  );
}

// A strip of desk round the paper, wider in front for the things on it.
const MARGIN = 0.3;
const FRONT = 1.45;
const FIT = {
  target: [0, 0, 0.2] as [number, number, number],
  from: [0, 1, 0.42] as [number, number, number],
  points: [-1, 1].flatMap((sx) =>
    [-H / 2 - MARGIN, H / 2 + FRONT].map(
      (z) => new THREE.Vector3(sx * (W / 2 + MARGIN), 0, z),
    ),
  ),
  // On a big window, below the HUD and left of the strokes gallery, so
  // neither covers the paper. Otherwise just clear of the nav bar.
  box: ({ width, height }: { width: number; height: number }) => [
    -0.98,
    width >= 1100 ? 1 - (2 * (268 + 16 + 14)) / width : 0.97,
    -0.99,
    1 - (2 * (width >= 1100 && height >= 640 ? 266 : 58)) / height,
  ],
};

function Lights() {
  return (
    <>
      <hemisphereLight args={["#ffe4c2", "#24140c", 0.32]} />
      <directionalLight
        color="#ffd29e"
        intensity={2.5}
        position={[-6, 11, 6]}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0003}
        shadow-normalBias={0.015}
        shadow-camera-left={-12}
        shadow-camera-right={12}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-camera-near={1}
        shadow-camera-far={40}
      />
      <directionalLight color="#8ea2ff" intensity={0.5} position={[9, 5, -8]} />
      {/* The pool of a desk lamp, off to the top left. */}
      <pointLight
        color="#ffa552"
        intensity={80}
        distance={30}
        position={[-9, 5, -6]}
      />
    </>
  );
}

// Dark walnut: streaky grain along x, a little lighter in the middle.
function Desk() {
  return (
    <mesh rotation-x={-Math.PI / 2} receiveShadow>
      <planeGeometry args={[80, 50]} />
      <meshPhysicalMaterial
        map={wood()}
        roughness={0.48}
        clearcoat={0.5}
        clearcoatRoughness={0.35}
      />
    </mesh>
  );
}
const wood = once(() => {
  const texture = paintTexture(1024, (ctx, size) => {
    ctx.fillStyle = "#2a1c15";
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 260; i++) {
      const y = Math.random() * size;
      const light = Math.random() < 0.5;
      ctx.strokeStyle = light
        ? `rgba(120, 80, 52, ${0.05 + Math.random() * 0.12})`
        : `rgba(10, 5, 3, ${0.08 + Math.random() * 0.2})`;
      ctx.lineWidth = 1 + Math.random() * 5;
      ctx.beginPath();
      const wave = 2 + Math.random() * 8;
      const phase = Math.random() * Math.PI * 2;
      for (let x = -10; x <= size + 10; x += 16) {
        const dy = Math.sin(x / 90 + phase) * wave;
        if (x < 0) ctx.moveTo(x, y + dy);
        else ctx.lineTo(x, y + dy);
      }
      ctx.stroke();
    }
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 2);
  return texture;
});

// Makes something the first time it's asked for.
function once<T>(make: () => T) {
  let made: T | undefined;
  return () => (made ??= make());
}

// Paper grain, as a bump map: speckle and the odd fibre.
const grain = once(() => {
  const texture = paintTexture(
    512,
    (ctx, size) => {
      const image = ctx.createImageData(size, size);
      for (let i = 0; i < image.data.length; i += 4) {
        const v = 128 + (Math.random() - 0.5) * 50;
        image.data.set([v, v, v, 255], i);
      }
      ctx.putImageData(image, 0, 0);
      for (let i = 0; i < 500; i++) {
        ctx.strokeStyle =
          Math.random() < 0.5 ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)";
        ctx.lineWidth = 0.6;
        const x = Math.random() * size;
        const y = Math.random() * size;
        const a = Math.random() * Math.PI;
        const l = 4 + Math.random() * 14;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(
          x + Math.cos(a) * l * 0.5 + 2,
          y + Math.sin(a) * l * 0.5,
          x + Math.cos(a) * l,
          y + Math.sin(a) * l,
        );
        ctx.stroke();
      }
    },
    THREE.NoColorSpace,
  );
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(7, 4);
  return texture;
});

// Notices when something is drawn on a 2D canvas, so its texture is only
// uploaded again when it has changed.
function watchInk(canvas: HTMLCanvasElement) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const ctx = canvas.getContext("2d")! as any;
  for (const name of ["stroke", "fill", "clearRect", "fillRect"]) {
    const draw = ctx[name].bind(ctx);
    ctx[name] = (...args: unknown[]) => {
      texture.needsUpdate = true;
      return draw(...args);
    };
  }
  return texture;
}

// A small stack of sheets, with the ink on the top one.
function Paper({ latestRef }: { latestRef: Latest }) {
  const ink = useRef<THREE.MeshStandardMaterial>(null);
  const texturesRef = useRef(new Map<HTMLCanvasElement, THREE.Texture>());
  useFrame(() => {
    const textures = texturesRef.current;
    const material = ink.current;
    const { board, timelapse, showTimelapse } = latestRef.current;
    const canvas = showTimelapse ? timelapse.current : board.current;
    if (!material || !canvas) return;
    let texture = textures.get(canvas);
    if (!texture) {
      texture = watchInk(canvas);
      textures.set(canvas, texture);
    }
    if (material.map !== texture) {
      material.map = texture;
      material.visible = true;
      material.needsUpdate = true;
    }
  });
  const sheet = (
    <meshPhysicalMaterial
      color="#f6f1e7"
      roughness={0.88}
      bumpMap={grain()}
      bumpScale={0.08}
      sheen={0.3}
      sheenColor="#fff6e8"
    />
  );
  return (
    <group>
      <RoundedBox
        args={[W + 0.1, 0.02, H + 0.08]}
        radius={0.008}
        position={[0.18, 0.01, 0.1]}
        rotation-y={-0.018}
        receiveShadow
        castShadow
      >
        <meshPhysicalMaterial color="#e6ddcd" roughness={0.9} />
      </RoundedBox>
      <RoundedBox
        args={[W, 0.02, H]}
        radius={0.008}
        position={[-0.1, 0.03, 0.05]}
        rotation-y={0.011}
        receiveShadow
        castShadow
      >
        <meshPhysicalMaterial color="#ede6d9" roughness={0.9} />
      </RoundedBox>
      <RoundedBox
        args={[W, 0.02, H]}
        radius={0.008}
        position-y={PAPER_Y - 0.01}
        receiveShadow
        castShadow
      >
        {sheet}
      </RoundedBox>
      <mesh
        rotation-x={-Math.PI / 2}
        position-y={PAPER_Y + 0.0015}
        receiveShadow
      >
        <planeGeometry args={[W, H]} />
        <meshStandardMaterial
          ref={ink}
          visible={false}
          transparent
          depthWrite={false}
          roughness={0.42}
          onBeforeCompile={richInk}
          bumpMap={grain()}
          bumpScale={0.04}
          polygonOffset
          polygonOffsetFactor={-1}
        />
      </mesh>
    </group>
  );
}

// Marker ink is deeper and more saturated than the flat colour it's drawn
// in on the 2D board.
function richInk(shader: { fragmentShader: string }) {
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <map_fragment>",
    /* glsl */ `
    #ifdef USE_MAP
      vec4 ink = texture2D(map, vMapUv);
      float grey = dot(ink.rgb, vec3(0.2126, 0.7152, 0.0722));
      ink.rgb = max(mix(vec3(grey), ink.rgb, 1.35), 0.0) * 0.8;
      diffuseColor *= ink;
    #endif
    `,
  );
}

// A marker, tip at the origin, pointing down. `accent` takes the pen's
// colour.
function Marker({
  group,
  tilt,
  accent,
}: {
  group: (g: THREE.Group | null) => void;
  tilt: (g: THREE.Group | null) => void;
  accent: (m: THREE.MeshPhysicalMaterial | null) => void;
}) {
  return (
    <group ref={group} visible={false}>
      {/* Leaning up the page and to the right, the way a pen in a right
          hand looks from above: tilted towards the camera it would be seen
          end on, and look like it was lying down. Its shadow falls the same
          way, so the two meet at the tip. */}
      <group ref={tilt} rotation={[LEAN.x, 0, LEAN.z]} scale={1.7}>
        <mesh position-y={0.06} castShadow>
          <cylinderGeometry args={[0.045, 0.012, 0.12, 20]} />
          <meshPhysicalMaterial ref={accent} roughness={0.6} />
        </mesh>
        <mesh position-y={0.17} castShadow>
          <cylinderGeometry args={[0.075, 0.06, 0.12, 28]} />
          <meshPhysicalMaterial
            color="#d9dbe3"
            roughness={0.3}
            metalness={0.6}
          />
        </mesh>
        <mesh position-y={0.84} castShadow>
          <cylinderGeometry args={[0.1, 0.09, 1.22, 32]} />
          <meshPhysicalMaterial
            color="#1b1e2b"
            roughness={0.25}
            clearcoat={1}
            clearcoatRoughness={0.1}
          />
        </mesh>
        <mesh position-y={1.52} castShadow>
          <cylinderGeometry args={[0.103, 0.103, 0.16, 32]} />
          <meshPhysicalMaterial
            ref={accent}
            roughness={0.3}
            clearcoat={1}
            clearcoatRoughness={0.1}
          />
        </mesh>
        <mesh position-y={1.6} scale={[1, 0.45, 1]} castShadow>
          <sphereGeometry
            args={[0.103, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2]}
          />
          <meshPhysicalMaterial
            ref={accent}
            roughness={0.3}
            clearcoat={1}
            clearcoatRoughness={0.1}
          />
        </mesh>
      </group>
    </group>
  );
}

type Slot = {
  stream: string | null;
  x: number;
  z: number;
  lift: number;
  // How fast it's moving, so it can lean back a touch against the stroke.
  vx: number;
  vz: number;
  group: THREE.Group | null;
  tilt: THREE.Group | null;
  accents: THREE.MeshPhysicalMaterial[];
};
const LEAN = { x: -0.42, z: -0.5 };
const drag = (v: number) => Math.max(-0.12, Math.min(0.12, v * 0.012));

// A marker for each pen that's down. Yours follows the pointer over the
// paper and touches down while you draw; the others sit where their pen is,
// and lift away when it comes up.
function Markers({
  latestRef,
  hoverRef,
}: {
  latestRef: Latest;
  hoverRef: Hover;
}) {
  const slotsRef = useRef<Slot[]>(
    Array.from({ length: MARKERS }, () => ({
      stream: null,
      x: 0,
      z: 0,
      lift: 0.8,
      vx: 0,
      vz: 0,
      group: null,
      tilt: null,
      accents: [],
    })),
  );
  useFrame((_, delta) => {
    const slots = slotsRef.current;
    const { me, pens } = latestRef.current;
    const k = Math.min(1, delta * 18);
    const show = (slot: Slot, down: boolean, raised: number) => {
      slot.lift += ((down ? 0 : raised) - slot.lift) * k;
      if (!slot.group || !slot.stream) return;
      const color = colorFor(slot.stream);
      for (const m of slot.accents) {
        if (m.userData.css !== color) {
          threeColor(color, m.color);
          m.userData.css = color;
        }
      }
      const { position } = slot.group;
      if (slot.group.visible) {
        const dt = Math.max(delta, 1 / 240);
        slot.vx += ((slot.x - position.x) / dt - slot.vx) * k;
        slot.vz += ((slot.z - position.z) / dt - slot.vz) * k;
      }
      slot.group.visible = true;
      position.set(slot.x, PAPER_Y + slot.lift, slot.z);
      // The top trails behind the tip.
      slot.tilt?.rotation.set(
        LEAN.x - drag(slot.vz),
        0,
        LEAN.z + drag(slot.vx),
      );
    };

    // Yours.
    const mine = slots[0];
    const drawing = pens.mine.get(me);
    const at = drawing ?? hoverRef.current;
    if (at) {
      mine.stream = me;
      mine.x = toWorldX(at.x);
      mine.z = toWorldZ(at.y);
      show(mine, !!drawing, 0.18);
    } else if (mine.group) {
      mine.group.visible = false;
    }

    // Everyone else's, each keeping its slot while its pen is down.
    const others = slots.slice(1);
    for (const [stream, point] of pens.others) {
      const slot =
        others.find((s) => s.stream === stream) ??
        others.find((s) => s.stream === null);
      if (!slot) continue;
      if (slot.stream !== stream) {
        slot.stream = stream;
        slot.lift = 0.8;
      }
      slot.x = toWorldX(point.x);
      slot.z = toWorldZ(point.y);
    }
    for (const slot of others) {
      if (!slot.stream) continue;
      const down = pens.others.has(slot.stream);
      show(slot, down, 0.8);
      if (!down && slot.lift > 0.7) {
        slot.stream = null;
        if (slot.group) slot.group.visible = false;
      }
    }
  });
  return (
    <>
      {Array.from({ length: MARKERS }, (_, i) => (
        <Marker
          key={i}
          group={(g) => {
            slotsRef.current[i].group = g;
          }}
          tilt={(g) => {
            slotsRef.current[i].tilt = g;
          }}
          accent={(m) => {
            const { accents } = slotsRef.current[i];
            if (m && !accents.includes(m)) accents.push(m);
          }}
        />
      ))}
    </>
  );
}

// A mug of coffee in Convex purple, a couple of spare markers and a pad of
// sticky notes, along the front edge of the paper, where nothing covers them.
function DeskThings() {
  const mug = useMemo(() => {
    const profile = [
      [0, 0],
      [0.6, 0],
      [0.66, 0.04],
      [0.7, 1.15],
      [0.68, 1.2],
      [0.63, 1.2],
      [0.6, 1.12],
      [0.57, 0.12],
      [0, 0.12],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    return new THREE.LatheGeometry(profile, 64);
  }, []);
  return (
    <group>
      <group position={[-7, 0, 5.2]} rotation-y={0.5}>
        <mesh geometry={mug} castShadow receiveShadow>
          <meshPhysicalMaterial
            color="#8D2676"
            roughness={0.25}
            clearcoat={1}
            clearcoatRoughness={0.05}
            side={THREE.DoubleSide}
          />
        </mesh>
        <mesh position={[0.7, 0.62, 0]} rotation-z={-Math.PI / 2} castShadow>
          <torusGeometry args={[0.3, 0.075, 16, 40, Math.PI]} />
          <meshPhysicalMaterial
            color="#8D2676"
            roughness={0.25}
            clearcoat={1}
            clearcoatRoughness={0.05}
          />
        </mesh>
        <mesh position-y={0.98} rotation-x={-Math.PI / 2}>
          <circleGeometry args={[0.6, 48]} />
          <meshPhysicalMaterial
            color="#2b170c"
            roughness={0.12}
            clearcoat={1}
          />
        </mesh>
      </group>
      <LyingMarker color="#F3B01C" position={[0.6, 0.11, 5.1]} turn={0.06} />
      <LyingMarker color="#EE342F" position={[2.7, 0.11, 5.42]} turn={-0.1} />
      {[0, 1, 2].map((i) => (
        <RoundedBox
          key={i}
          args={[1.3, 0.03, 1.3]}
          radius={0.012}
          position={[6.2 + i * 0.03, 0.015 + i * 0.03, 5.15 - i * 0.02]}
          rotation-y={-0.1 + i * 0.06}
          castShadow
          receiveShadow
        >
          <meshPhysicalMaterial
            color={i === 2 ? "#F3B01C" : "#e9a516"}
            roughness={0.8}
          />
        </RoundedBox>
      ))}
    </group>
  );
}

function LyingMarker({
  color,
  position,
  turn,
}: {
  color: string;
  position: [number, number, number];
  turn: number;
}) {
  return (
    <group position={position} rotation={[0, turn, Math.PI / 2]}>
      <mesh castShadow receiveShadow>
        <cylinderGeometry args={[0.11, 0.11, 1.9, 32]} />
        <meshPhysicalMaterial
          color="#1b1e2b"
          roughness={0.25}
          clearcoat={1}
          clearcoatRoughness={0.1}
        />
      </mesh>
      <mesh position-y={1.2} castShadow receiveShadow>
        <cylinderGeometry args={[0.125, 0.125, 0.55, 32]} />
        <meshPhysicalMaterial
          color={color}
          roughness={0.3}
          clearcoat={1}
          clearcoatRoughness={0.1}
        />
      </mesh>
      <mesh position-y={-1.0} castShadow>
        <cylinderGeometry args={[0.112, 0.112, 0.12, 32]} />
        <meshPhysicalMaterial color={color} roughness={0.3} />
      </mesh>
    </group>
  );
}

// Turns pointer events on the scene into board coordinates, where the ray
// meets the paper. A stroke can only start on the paper, but once started
// it follows the pointer anywhere, as the 2D board did.
function PaperInput({
  latestRef,
  hoverRef,
}: {
  latestRef: Latest;
  hoverRef: Hover;
}) {
  const camera = useThree((s) => s.camera);
  const element = useThree((s) => s.gl.domElement);
  useEffect(() => {
    const toBoard = (e: PointerEvent): Point | null => {
      const hit = pointOnPlane(camera, element, e.clientX, e.clientY, PAPER_Y);
      if (!hit) return null;
      return {
        x: Math.round(hit.x / SCALE + WIDTH / 2),
        y: Math.round(hit.z / SCALE + HEIGHT / 2),
      };
    };
    const onPaper = (p: Point) =>
      p.x >= 0 && p.x <= WIDTH && p.y >= 0 && p.y <= HEIGHT;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const point = toBoard(e);
      if (!point || !onPaper(point)) return;
      element.setPointerCapture(e.pointerId);
      hoverRef.current = point;
      latestRef.current.onPenDown(point);
    };
    const onMove = (e: PointerEvent) => {
      const point = toBoard(e);
      if (!point) return;
      hoverRef.current = onPaper(point) ? point : null;
      // Over the paper, your marker is the pointer.
      element.style.setProperty(
        "cursor",
        hoverRef.current || latestRef.current.pens.mine.size ? "none" : "",
      );
      latestRef.current.onPenMove(point);
    };
    const onUp = (e: PointerEvent) => {
      const point = toBoard(e);
      if (point) latestRef.current.onPenUp(point);
    };
    const onLeave = () => {
      hoverRef.current = null;
    };
    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onUp);
    element.addEventListener("pointerleave", onLeave);
    return () => {
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onUp);
      element.removeEventListener("pointerleave", onLeave);
    };
  }, [camera, element, latestRef, hoverRef]);
  return null;
}
