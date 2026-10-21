// The racer in 3D. Racer.tsx runs the game and the replay; this only draws
// the cars it's given, where it's told, from one of three cameras.
import { memo, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import {
  Bloom,
  BrightnessContrast,
  EffectComposer,
  HueSaturation,
  ToneMapping,
  Vignette,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import * as THREE from "three";
import { LAP_LENGTH, TOP_Y } from "./racerTrack";
import { trackOffset, worldX, worldZ, type CameraName } from "./racer3d";
import { GhostTrail, RaceCar, type Pose } from "./RacerCar";
import RacerWorld, { HORIZON, SKY } from "./RacerWorld";

type Player = { car: Pose; color: string };
type Shot = { position: THREE.Vector3; target: THREE.Vector3; fov: number };

const LINE_Z = worldZ(TOP_Y);

// TV: high, from the grandstand's far corner, with the whole track in frame
// (and a little room at the top for the HUD) at any window shape.
function tvShot(aspect: number): Shot {
  const fov = 30;
  const azimuth = 0.3;
  const elevation = 0.86;
  const toCamera = new THREE.Vector3(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  );
  const points: THREE.Vector3[] = [];
  for (let d = 0; d < LAP_LENGTH; d += 40) {
    const p = trackOffset(d, -165); // just outside the barriers
    points.push(new THREE.Vector3(p.x, 0, p.z));
  }
  points.push(
    new THREE.Vector3(-275, 118, LINE_Z - 260),
    new THREE.Vector3(275, 118, LINE_Z - 260),
  );
  const frame = { left: -0.93, right: 0.93, bottom: -0.9, top: 0.7 };
  const camera = new THREE.PerspectiveCamera(fov, aspect, 1, 20000);
  const target = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  const bounds = (distance: number) => {
    camera.position.copy(target).addScaledVector(toCamera, distance);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    const b = { minX: 9, maxX: -9, minY: 9, maxY: -9 };
    for (const p of points) {
      ndc.copy(p).project(camera);
      if (ndc.z > 1) return { minX: -9, maxX: 9, minY: -9, maxY: 9 }; // behind
      b.minX = Math.min(b.minX, ndc.x);
      b.maxX = Math.max(b.maxX, ndc.x);
      b.minY = Math.min(b.minY, ndc.y);
      b.maxY = Math.max(b.maxY, ndc.y);
    }
    return b;
  };
  let distance = 3000;
  for (let round = 0; round < 8; round++) {
    // The nearest distance that fits, then nudge the aim to centre it.
    let near = 200;
    let far = 20000;
    for (let i = 0; i < 30; i++) {
      const mid = (near + far) / 2;
      const b = bounds(mid);
      const fits =
        b.minX >= frame.left &&
        b.maxX <= frame.right &&
        b.minY >= frame.bottom &&
        b.maxY <= frame.top;
      if (fits) far = mid;
      else near = mid;
    }
    distance = far;
    const b = bounds(distance);
    const halfHeight = distance * Math.tan(THREE.MathUtils.degToRad(fov / 2));
    const offX = (b.minX + b.maxX - frame.left - frame.right) / 2;
    const offY = (b.minY + b.maxY - frame.bottom - frame.top) / 2;
    target.x += offX * halfHeight * aspect * 0.8;
    target.z -= ((offY * halfHeight) / Math.sin(elevation)) * 0.8;
  }
  return {
    position: target.clone().addScaledVector(toCamera, distance),
    target,
    fov,
  };
}

// Finish: low and side-on from the infield, close to the inside lane and
// looking across the line, like a photo-finish camera. Both lanes fill the
// middle of the frame, with about 150 px of track either side of the line
// and the grandstand behind.
function finishShot(aspect: number): Shot {
  const span = 150;
  const distance = THREE.MathUtils.clamp(
    span / (Math.tan(THREE.MathUtils.degToRad(22)) * aspect),
    210,
    330,
  );
  const fov = THREE.MathUtils.clamp(
    THREE.MathUtils.radToDeg(2 * Math.atan(span / (distance * aspect))),
    44,
    70,
  );
  // About two car heights up, looking a touch down at the line. A narrow
  // window needs a wider lens, so go higher and look further down, to
  // fill it with track rather than sky and grass.
  const wider = fov - 44;
  const height = distance * (0.26 + wider * 0.012);
  const pitch = THREE.MathUtils.degToRad(6 + wider * 0.35);
  return {
    position: new THREE.Vector3(0, height, LINE_Z + distance),
    target: new THREE.Vector3(0, height - distance * Math.tan(pitch), LINE_Z),
    fov,
  };
}

// Chase: behind your car and a little above, swinging round smoothly.
function chaseShot(car: Pose, angle: number, aspect: number): Shot {
  const x = worldX(car.x);
  const z = worldZ(car.y);
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  return {
    position: new THREE.Vector3(x - dx * 175, 70, z - dz * 175),
    target: new THREE.Vector3(x + dx * 110, 14, z + dz * 110),
    fov: aspect < 1 ? 62 : 48,
  };
}

const ease = (t: number) => t * t * (3 - 2 * t);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function CameraRig({ mode, me }: { mode: CameraName; me: Pose }) {
  const rig = useRef({
    mode: null as CameraName | null,
    from: null as Shot | null,
    t: 1,
    angle: me.angle,
    aspect: 0,
    tv: null as Shot | null,
    finish: null as Shot | null,
    target: new THREE.Vector3(),
  });
  useFrame(({ camera, size }, dt) => {
    const r = rig.current;
    const aspect = size.width / size.height;
    if (aspect !== r.aspect) {
      r.aspect = aspect;
      r.tv = tvShot(aspect);
      r.finish = finishShot(aspect);
    }
    r.angle += wrap(me.angle - r.angle) * (1 - Math.exp(-4 * dt));
    const shot =
      mode === "tv"
        ? r.tv!
        : mode === "finish"
          ? r.finish!
          : chaseShot(me, r.angle, aspect);
    const lens = camera as THREE.PerspectiveCamera;
    if (r.mode !== mode) {
      // Glide from wherever the camera is now, except on the first frame.
      r.from =
        r.mode === null
          ? null
          : {
              position: lens.position.clone(),
              target: r.target.clone(),
              fov: lens.fov,
            };
      if (mode === "chase") r.angle = me.angle;
      r.mode = mode;
      r.t = 0;
    }
    r.t = Math.min(1, r.t + dt / 1.3);
    const e = r.from && r.t < 1 ? ease(r.t) : 1;
    const from = r.from ?? shot;
    lens.position.lerpVectors(from.position, shot.position, e);
    r.target.lerpVectors(from.target, shot.target, e);
    const fov = THREE.MathUtils.lerp(from.fov, shot.fov, e);
    if (fov !== lens.fov) {
      lens.fov = fov;
      lens.updateProjectionMatrix();
    }
    lens.lookAt(r.target);
  });
  return null;
}

// Image-based light from a dusk studio of soft panels: a warm sunset strip
// low on one side, cool blue sky overhead, so the clearcoat has something to
// reflect without washing the colour out.
const Studio = memo(function Studio() {
  return (
    <Environment resolution={256} frames={1} environmentIntensity={0.55}>
      <color attach="background" args={["#070a18"]} />
      <Lightformer
        form="rect"
        intensity={1.2}
        color="#6f86d8"
        position={[0, 6, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        scale={[12, 12, 1]}
      />
      <Lightformer
        form="rect"
        intensity={3.5}
        color="#ff8a4a"
        position={[-6, 1.2, -3]}
        rotation={[0, Math.PI / 3, 0]}
        scale={[10, 1.6, 1]}
      />
      <Lightformer
        form="rect"
        intensity={2}
        color="#5f7dff"
        position={[6, 2, 3]}
        rotation={[0, -Math.PI / 1.5, 0]}
        scale={[8, 2.5, 1]}
      />
      <Lightformer
        form="ring"
        intensity={2.5}
        color="#ffe2b0"
        position={[0, 3, 8]}
        scale={2}
      />
      <Lightformer
        form="rect"
        intensity={0.4}
        color="#1d3a18"
        position={[0, -4, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[20, 20, 1]}
      />
    </Environment>
  );
});

// A low orange sun from the sunset side, raking long shadows across the
// track, and a cool blue sky fill from the other.
const Lights = memo(function Lights() {
  const key = useMemo(() => {
    const light = new THREE.DirectionalLight("#ffa66b", 2.6);
    light.position.set(-1100, 620, -700);
    light.castShadow = true;
    light.shadow.mapSize.set(4096, 4096);
    Object.assign(light.shadow.camera, {
      left: -1250,
      right: 1250,
      top: 1100,
      bottom: -1100,
      near: 50,
      far: 4000,
    });
    light.shadow.camera.updateProjectionMatrix();
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.6;
    return light;
  }, []);
  return (
    <>
      <primitive object={key} />
      <directionalLight
        color="#5d78ff"
        intensity={0.9}
        position={[700, 500, 900]}
      />
      <hemisphereLight args={["#4a5ca8", "#16240f", 0.45]} />
    </>
  );
});

// Bloom on things that glow, filmic tone mapping, then a little more
// contrast and colour, and a vignette.
const Post = memo(function Post() {
  return (
    <EffectComposer multisampling={4}>
      <Bloom
        mipmapBlur
        intensity={1.1}
        luminanceThreshold={1.1}
        luminanceSmoothing={0.3}
        radius={0.8}
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <BrightnessContrast contrast={0.08} />
      <HueSaturation saturation={0.18} />
      <Vignette offset={0.3} darkness={0.7} />
    </EffectComposer>
  );
});

// A soft dark patch under each car, so it sits on the road.
function useBlobTexture() {
  return useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0, "rgba(0,0,0,0.75)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(canvas);
  }, []);
}

function Blob({ texture }: { texture: THREE.Texture }) {
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 1.8, 0]}
      renderOrder={1}
    >
      <planeGeometry args={[60, 40]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  );
}

export default function RacerScene({
  me,
  ghost,
  others,
  camera,
}: {
  me: Player;
  ghost: Player | null;
  others: (Player & { id: string })[];
  camera: CameraName;
}) {
  const blob = useBlobTexture();
  return (
    <Canvas
      className="racer-canvas"
      shadows
      dpr={[1, 2]}
      gl={{ antialias: false, powerPreference: "high-performance" }}
      camera={{ fov: 30, near: 5, far: 20000, position: [0, 1600, 1600] }}
    >
      <color attach="background" args={[SKY]} />
      <fog attach="fog" args={[HORIZON, 3200, 9000]} />
      <Studio />
      <Lights />
      <RacerWorld />
      {others.map((other) => (
        <RaceCar
          key={other.id}
          car={other.car}
          color={other.color}
          kind="other"
        >
          <Blob texture={blob} />
        </RaceCar>
      ))}
      {ghost && (
        <>
          <RaceCar car={ghost.car} color={ghost.color} kind="ghost" />
          <GhostTrail car={ghost.car} color={ghost.color} />
        </>
      )}
      <RaceCar car={me.car} color={me.color} kind="me">
        <Blob texture={blob} />
      </RaceCar>
      <CameraRig mode={camera} me={me.car} />
      <Post />
    </Canvas>
  );
}
