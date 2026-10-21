// A chunky little race car, built from rounded boxes and cylinders, and its
// ghost: the same car in glowing glass, with a trail.
import { memo, useMemo, useRef, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { heading, toColor, worldX, worldZ } from "./racer3d";

export type Pose = { x: number; y: number; angle: number };
type Kind = "me" | "other" | "ghost";

// The car is built in its own units, then scaled up so it reads on video:
// 1.8 times leaves it about 62 px wide, which still fits two abreast in
// autodrive's lanes, 70 px apart.
export const CAR_SCALE = 1.8;
const WHEELBASE = 25 * CAR_SCALE;
const WHEELS = [
  { x: 13, z: 13.5, radius: 6.2, width: 6, front: true },
  { x: 13, z: -13.5, radius: 6.2, width: 6, front: true },
  { x: -12, z: 13.5, radius: 7, width: 7.5, front: false },
  { x: -12, z: -13.5, radius: 7, width: 7.5, front: false },
];

type Materials = {
  paint: THREE.Material;
  carbon: THREE.Material;
  tyre: THREE.Material;
  rim: THREE.Material;
  helmet: THREE.Material;
  visor: THREE.Material;
};

// One clock for every ghost's shimmer.
const ghostTime = { value: 0 };

// The player's colour, deep and saturated, whatever colorFor gave.
function paintColor(color: THREE.Color, lightness = 0.42) {
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  return new THREE.Color().setHSL(hsl.h, Math.max(hsl.s, 0.9), lightness);
}

// Glass that glows at the edges: brightest where you see a surface side-on.
function ghostMaterial(color: THREE.Color) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: {
      color: { value: color.clone() },
      time: ghostTime,
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vHeight;
      void main() {
        vHeight = (modelMatrix * vec4(position, 1.0)).y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform float time;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vHeight;
      void main() {
        // Clamped: on a GPU the dot can land a hair over 1, and pow() of a
        // negative number is NaN, which bloom then spreads over the frame.
        float rim = pow(clamp(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 0.0, 1.0), 1.6);
        float pulse = 0.85 + 0.15 * sin(time * 4.0);
        // Faint bands drifting up through it, like a hologram.
        float band = 0.75 + 0.25 * sin(vHeight * 1.4 - time * 6.0);
        vec3 c = color * (0.18 + 3.4 * rim) * pulse * band;
        // A white-hot edge, so it glows whatever colour it is.
        c += vec3(1.0) * pow(rim, 3.0) * 0.9 * pulse;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

function useMaterials(color: string, kind: Kind): Materials {
  return useMemo(() => {
    if (kind === "ghost") {
      const glass = ghostMaterial(paintColor(toColor(color), 0.55));
      return {
        paint: glass,
        carbon: glass,
        tyre: glass,
        rim: glass,
        helmet: glass,
        visor: glass,
      };
    }
    const paint = paintColor(toColor(color));
    return {
      // Candy paint: a metallic base tints its reflections, so the colour
      // stays rich even where the clearcoat catches the light.
      paint: new THREE.MeshPhysicalMaterial({
        color: paint,
        roughness: 0.38,
        metalness: 0.45,
        clearcoat: 1,
        clearcoatRoughness: 0.1,
        envMapIntensity: 0.7,
      }),
      carbon: new THREE.MeshStandardMaterial({
        color: "#1b1d24",
        roughness: 0.45,
        metalness: 0.3,
      }),
      tyre: new THREE.MeshStandardMaterial({
        color: "#141418",
        roughness: 0.85,
      }),
      rim: new THREE.MeshStandardMaterial({
        color: "#dfe3ea",
        roughness: 0.25,
        metalness: 0.9,
      }),
      helmet: new THREE.MeshPhysicalMaterial({
        color: "#F3B01C",
        roughness: 0.25,
        clearcoat: 1,
      }),
      visor: new THREE.MeshPhysicalMaterial({
        color: "#0c0f18",
        roughness: 0.05,
        metalness: 0.6,
        clearcoat: 1,
      }),
    };
  }, [color, kind]);
}

function Part({
  size,
  at,
  radius = 2,
  material,
  shadow,
}: {
  size: [number, number, number];
  at: [number, number, number];
  radius?: number;
  material: THREE.Material;
  shadow: boolean;
}) {
  return (
    <RoundedBox
      args={size}
      radius={radius}
      smoothness={3}
      position={at}
      material={material}
      castShadow={shadow}
    />
  );
}

const Wheel = memo(function Wheel({
  radius,
  width,
  side,
  m,
  shadow,
}: {
  radius: number;
  width: number;
  side: number;
  m: Materials;
  shadow: boolean;
}) {
  return (
    <group>
      <mesh
        rotation={[Math.PI / 2, 0, 0]}
        material={m.tyre}
        castShadow={shadow}
      >
        <cylinderGeometry args={[radius, radius, width, 20]} />
      </mesh>
      <mesh
        rotation={[Math.PI / 2, 0, 0]}
        position={[0, 0, (side * width) / 2]}
        material={m.rim}
      >
        <cylinderGeometry args={[radius * 0.62, radius * 0.62, 0.8, 16]} />
      </mesh>
      {/* Spokes, so you can see the wheels turn. */}
      {[0, Math.PI / 3, (2 * Math.PI) / 3].map((a) => (
        <mesh
          key={a}
          rotation={[0, 0, a]}
          position={[0, 0, side * (width / 2 + 0.5)]}
          material={m.paint}
        >
          <boxGeometry args={[radius * 1.15, 1.1, 0.6]} />
        </mesh>
      ))}
    </group>
  );
});

const Body = memo(function Body({
  m,
  shadow,
}: {
  m: Materials;
  shadow: boolean;
}) {
  const s = shadow;
  return (
    <group>
      {/* The tub and sidepods. */}
      <Part
        size={[36, 6.5, 14]}
        at={[0, 7, 0]}
        radius={2.6}
        material={m.paint}
        shadow={s}
      />
      <Part
        size={[17, 6, 24]}
        at={[-3, 7, 0]}
        radius={2.6}
        material={m.paint}
        shadow={s}
      />
      {/* The nose and front wing. */}
      <Part
        size={[14, 4.5, 9]}
        at={[17, 6, 0]}
        radius={2}
        material={m.paint}
        shadow={s}
      />
      <Part
        size={[5, 1.6, 30]}
        at={[23, 3, 0]}
        radius={0.7}
        material={m.carbon}
        shadow={s}
      />
      <Part
        size={[7, 4.5, 1.4]}
        at={[23, 4, 15]}
        radius={0.6}
        material={m.paint}
        shadow={s}
      />
      <Part
        size={[7, 4.5, 1.4]}
        at={[23, 4, -15]}
        radius={0.6}
        material={m.paint}
        shadow={s}
      />
      {/* The cockpit, driver and engine cover. */}
      <Part
        size={[11, 3, 11]}
        at={[2, 10.5, 0]}
        radius={1.4}
        material={m.carbon}
        shadow={s}
      />
      <mesh position={[0.5, 13, 0]} material={m.helmet} castShadow={s}>
        <sphereGeometry args={[3.7, 20, 14]} />
      </mesh>
      <Part
        size={[2, 1.8, 5]}
        at={[3.6, 13.3, 0]}
        radius={0.8}
        material={m.visor}
        shadow={false}
      />
      <Part
        size={[16, 7.5, 8]}
        at={[-9, 11, 0]}
        radius={3}
        material={m.paint}
        shadow={s}
      />
      {/* The rear wing, on a strut. */}
      <Part
        size={[2.2, 8, 2]}
        at={[-22, 13, 0]}
        radius={0.6}
        material={m.carbon}
        shadow={s}
      />
      <Part
        size={[6.5, 1.8, 27]}
        at={[-24, 17.5, 0]}
        radius={0.8}
        material={m.carbon}
        shadow={s}
      />
      <Part
        size={[9, 8, 1.4]}
        at={[-24, 15.5, 13.6]}
        radius={0.6}
        material={m.paint}
        shadow={s}
      />
      <Part
        size={[9, 8, 1.4]}
        at={[-24, 15.5, -13.6]}
        radius={0.6}
        material={m.paint}
        shadow={s}
      />
    </group>
  );
});

// "You" marker: a little yellow arrow bobbing over your own car.
function Marker() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.position.y = 38 + Math.sin(clock.elapsedTime * 3) * 2;
    ref.current.rotation.y = clock.elapsedTime * 1.5;
  });
  return (
    <mesh ref={ref} rotation={[Math.PI, 0, 0]} scale={0.7}>
      <coneGeometry args={[5.5, 10, 4]} />
      <meshStandardMaterial
        color="#F3B01C"
        emissive="#F3B01C"
        emissiveIntensity={5}
        toneMapped={false}
      />
    </mesh>
  );
}

export function RaceCar({
  car,
  color,
  kind,
  children,
}: {
  car: Pose;
  color: string;
  kind: Kind;
  children?: ReactNode;
}) {
  const m = useMaterials(color, kind);
  const shadow = kind !== "ghost";
  const root = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const steers = useRef<(THREE.Group | null)[]>([]);
  const spins = useRef<(THREE.Group | null)[]>([]);
  const motion = useRef({
    x: 0,
    z: 0,
    angle: 0,
    steer: 0,
    roll: 0,
    ready: false,
  });

  // Work out the speed and the turn from how far the car moved this frame,
  // so cars played back from other windows spin and steer their wheels too.
  useFrame(({ clock }, dt) => {
    const group = root.current;
    if (!group || dt <= 0) return;
    if (kind === "ghost") ghostTime.value = clock.elapsedTime;
    const last = motion.current;
    const { x, z } = group.position;
    const angle = -group.rotation.y;
    const dx = x - last.x;
    const dz = z - last.z;
    const moved = Math.hypot(dx, dz);
    const turned = angle - last.angle;
    Object.assign(last, { x, z, angle });
    if (!last.ready || moved > 120) {
      last.ready = true;
      return;
    }
    const forward = Math.cos(angle) * dx + Math.sin(angle) * dz < 0 ? -1 : 1;
    const speed = moved / dt;
    const turnRate = turned / dt;
    const steerTo =
      speed > 20
        ? THREE.MathUtils.clamp(
            -Math.atan((turnRate * WHEELBASE) / speed),
            -0.5,
            0.5,
          )
        : last.steer * 0.9;
    const rollTo = THREE.MathUtils.clamp(
      -turnRate * speed * 0.00009,
      -0.09,
      0.09,
    );
    last.steer = THREE.MathUtils.damp(last.steer, steerTo, 10, dt);
    last.roll = THREE.MathUtils.damp(last.roll, rollTo, 6, dt);
    steers.current.forEach((g, i) => {
      if (g && WHEELS[i].front) g.rotation.y = last.steer;
    });
    spins.current.forEach((g, i) => {
      if (g) g.rotation.z -= (forward * moved) / (WHEELS[i].radius * CAR_SCALE);
    });
    if (body.current) body.current.rotation.x = last.roll;
  });

  return (
    <group
      ref={root}
      position={[worldX(car.x), 0, worldZ(car.y)]}
      rotation={[0, heading(car.angle), 0]}
      scale={CAR_SCALE * (kind === "ghost" ? 1.04 : 1)}
    >
      <group ref={body}>
        <Body m={m} shadow={shadow} />
      </group>
      {WHEELS.map((w, i) => (
        <group
          key={i}
          position={[w.x, w.radius, w.z]}
          ref={(g) => {
            steers.current[i] = g;
          }}
        >
          <group
            ref={(g) => {
              spins.current[i] = g;
            }}
          >
            <Wheel
              radius={w.radius}
              width={w.width}
              side={Math.sign(w.z)}
              m={m}
              shadow={shadow}
            />
          </group>
        </group>
      ))}
      {kind === "me" && <Marker />}
      {children}
    </group>
  );
}

// A fading ribbon of light along the ground, where the ghost has just been.
const TRAIL_POINTS = 70;
export function GhostTrail({ car, color }: { car: Pose; color: string }) {
  const trail = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 2 * 3), 3),
    );
    const fade = new Float32Array(TRAIL_POINTS * 2);
    for (let i = 0; i < TRAIL_POINTS; i++) {
      fade[i * 2] = fade[i * 2 + 1] = 1 - i / (TRAIL_POINTS - 1);
    }
    geometry.setAttribute("fade", new THREE.BufferAttribute(fade, 1));
    const index: number[] = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        color: {
          value: paintColor(toColor(color), 0.55),
        },
      },
      vertexShader: /* glsl */ `
        attribute float fade;
        varying float vFade;
        void main() {
          vFade = fade;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 color;
        varying float vFade;
        void main() {
          gl_FragColor = vec4(color * 2.2 * vFade * vFade, 1.0);
        }`,
    });
    return { geometry, material };
  }, [color]);
  const recent = useRef<THREE.Vector2[]>([]);

  useFrame(() => {
    const { geometry } = trail;
    const points = recent.current;
    const head = new THREE.Vector2(worldX(car.x), worldZ(car.y));
    if (points.length && points[0].distanceTo(head) > 150) points.length = 0;
    if (!points.length || points[0].distanceTo(head) > 3) {
      points.unshift(head);
      if (points.length > TRAIL_POINTS) points.length = TRAIL_POINTS;
    }
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < points.length; i++) {
      const a = points[Math.max(i - 1, 0)];
      const b = points[Math.min(i + 1, points.length - 1)];
      const dx = b.x - a.x;
      const dz = b.y - a.y;
      const length = Math.hypot(dx, dz) || 1;
      const width = (9 * (1 - i / TRAIL_POINTS) + 2) * CAR_SCALE;
      const nx = (-dz / length) * width;
      const nz = (dx / length) * width;
      position.setXYZ(i * 2, points[i].x + nx, 2.5, points[i].y + nz);
      position.setXYZ(i * 2 + 1, points[i].x - nx, 2.5, points[i].y - nz);
    }
    position.needsUpdate = true;
    geometry.setDrawRange(0, Math.max(0, points.length - 1) * 6);
  });

  return (
    <mesh
      geometry={trail.geometry}
      material={trail.material}
      frustumCulled={false}
    />
  );
}
