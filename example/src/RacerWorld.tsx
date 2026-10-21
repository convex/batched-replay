// Everything in the racer's 3D view that doesn't move (much): the track, the
// grass, trees, barriers, a grandstand and the start/finish gantry.
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { LAP_LENGTH, TOP_Y, TRACK_WIDTH } from "./racerTrack";
import {
  BENDS,
  asphaltTexture,
  bannerTexture,
  chequerTexture,
  fromTrack,
  inField,
  grassTexture,
  kerbTexture,
  lapRibbon,
  random,
  ribbon,
  trackOffset,
  worldZ,
} from "./racer3d";

export const SKY = "#050816";
export const HORIZON = "#2a1d45";
const HALF = TRACK_WIDTH / 2;
const LINE_Z = worldZ(TOP_Y);
// The barrier runs round the outside, BARRIER px from the middle.
const BARRIER = 150;

function Ground() {
  const geometry = useMemo(() => {
    const plane = new THREE.PlaneGeometry(16000, 16000, 200, 200);
    plane.rotateX(-Math.PI / 2);
    // Deep green under the dusk, in gentle patches of lighter and yellower.
    const position = plane.getAttribute("position");
    const colors = new Float32Array(position.count * 3);
    const color = new THREE.Color();
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const z = position.getZ(i);
      const n =
        Math.sin(x * 0.004 + Math.cos(z * 0.003) * 2) * 0.5 +
        Math.sin(z * 0.006 - x * 0.002) * 0.3 +
        Math.sin((x + z) * 0.011) * 0.2;
      color.setHSL(0.29 - n * 0.02, 0.62 + n * 0.06, 0.2 + n * 0.03);
      color.toArray(colors, i * 3);
    }
    plane.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return plane;
  }, []);
  const map = useMemo(() => {
    const texture = grassTexture();
    texture.repeat.set(16000 / 520, 16000 / 520);
    return texture;
  }, []);
  return (
    <mesh geometry={geometry} receiveShadow>
      <meshStandardMaterial vertexColors map={map} roughness={0.95} />
    </mesh>
  );
}

// A soft gradient dome, deep navy overhead, dusky purple lower down and the
// last of the sunset burning orange along the horizon.
function Sky() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: new THREE.Color(SKY) },
          horizon: { value: new THREE.Color(HORIZON) },
          glow: { value: new THREE.Color("#ff6a2e") },
          haze: { value: new THREE.Color("#7a2a6a") },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 top;
          uniform vec3 horizon;
          uniform vec3 glow;
          uniform vec3 haze;
          varying vec3 vDir;
          void main() {
            float h = clamp(vDir.y, 0.0, 1.0);
            vec3 c = mix(horizon, top, smoothstep(0.0, 0.5, h));
            // A warm glow low down on the side the sun is setting.
            // Guard the length: straight up, the flat direction is zero,
            // and a NaN there would spread across the whole frame via bloom.
            vec3 across = vec3(vDir.x, 0.0, vDir.z);
            float sun = max(dot(normalize(vec3(-0.6, 0.0, -0.8)), across / max(length(across), 1e-4)), 0.0);
            c += haze * pow(sun, 1.5) * (1.0 - smoothstep(0.0, 0.35, h)) * 0.6;
            c += glow * pow(sun, 4.0) * (1.0 - smoothstep(0.0, 0.12, h)) * 0.9;
            gl_FragColor = vec4(c, 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    [],
  );
  return (
    <mesh material={material} renderOrder={-1}>
      <sphereGeometry args={[9500, 32, 16]} />
    </mesh>
  );
}

function Track() {
  const asphalt = useMemo(() => {
    const texture = asphaltTexture();
    texture.repeat.set(1 / 120, 1 / 120);
    return texture;
  }, []);
  const kerb = useMemo(() => {
    const texture = kerbTexture();
    texture.repeat.set(1 / 48, 1);
    return texture;
  }, []);
  const chequer = useMemo(() => chequerTexture(2, 10), []);
  const shapes = useMemo(
    () => ({
      asphalt: lapRibbon(-HALF, HALF, 0.6),
      edges: [
        lapRibbon(HALF - 9, HALF - 4, 0.9),
        lapRibbon(-HALF + 4, -HALF + 9, 0.9),
      ],
      kerbs: BENDS.flatMap(([from, to]) => [
        ribbon(from - 40, to + 40, HALF - 2, HALF + 16, 1.2, 6),
        ribbon(from - 40, to + 40, -HALF - 16, -HALF + 2, 1.2, 6),
      ]),
      gravel: BENDS.map(([from, to]) =>
        ribbon(from + 30, to - 30, -HALF - 22, -BARRIER + 12, 0.35, 10),
      ),
      shoulder: lapRibbon(-HALF - 6, HALF + 6, 0.3),
    }),
    [],
  );
  return (
    <group>
      <mesh geometry={shapes.shoulder} receiveShadow>
        <meshStandardMaterial color="#34343a" roughness={1} />
      </mesh>
      <mesh geometry={shapes.asphalt} receiveShadow>
        <meshStandardMaterial
          color="#4d505a"
          map={asphalt}
          roughness={0.82}
          metalness={0}
          polygonOffset
          polygonOffsetFactor={-1}
        />
      </mesh>
      {shapes.edges.map((edge, i) => (
        <mesh key={i} geometry={edge} receiveShadow>
          <meshStandardMaterial
            color="#d8d8d4"
            roughness={0.6}
            polygonOffset
            polygonOffsetFactor={-2}
          />
        </mesh>
      ))}
      {shapes.kerbs.map((shape, i) => (
        <mesh key={i} geometry={shape} receiveShadow>
          <meshStandardMaterial
            map={kerb}
            roughness={0.55}
            polygonOffset
            polygonOffsetFactor={-3}
          />
        </mesh>
      ))}
      {shapes.gravel.map((shape, i) => (
        <mesh key={i} geometry={shape} receiveShadow>
          <meshStandardMaterial color="#a0835a" roughness={1} />
        </mesh>
      ))}
      {/* The chequered line, 2 squares by 10, like the 2D track's. */}
      <mesh
        position={[0, 1.4, LINE_Z]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[TRACK_WIDTH / 5, TRACK_WIDTH]} />
        <meshStandardMaterial
          map={chequer}
          roughness={0.5}
          polygonOffset
          polygonOffsetFactor={-4}
        />
      </mesh>
      <GridSlots />
    </group>
  );
}

// White grid boxes behind the line, where the out lap starts.
function GridSlots() {
  const slots = [-200, -260, -320];
  return (
    <group>
      {slots.flatMap((x, i) =>
        [-1, 1].map((side) => (
          <mesh
            key={`${i}${side}`}
            position={[x + (side > 0 ? 30 : 0), 1, LINE_Z + side * 32]}
            rotation={[-Math.PI / 2, 0, 0]}
          >
            <planeGeometry args={[4, 26]} />
            <meshStandardMaterial
              color="#e8e8e4"
              roughness={0.6}
              polygonOffset
              polygonOffsetFactor={-2}
            />
          </mesh>
        )),
      )}
    </group>
  );
}

// Blocks round the outside: red and white on the bends, Convex purple and
// yellow boards down the straights.
function Barriers() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const blocks = useMemo(() => {
    const list: { x: number; z: number; angle: number; color: string }[] = [];
    const length = 24;
    for (let d = 0, i = 0; d < LAP_LENGTH; d += length, i++) {
      const p = trackOffset(d + length / 2, -BARRIER);
      const onBend = BENDS.some(([from, to]) => d > from - 20 && d < to + 20);
      const color = onBend
        ? i % 2
          ? "#EE342F"
          : "#d6d6d6"
        : i % 6 === 0
          ? "#F3B01C"
          : "#8D2676";
      list.push({ x: p.x, z: p.z, angle: p.angle, color });
    }
    return list;
  }, []);
  useLayoutEffect(() => {
    const mesh = ref.current!;
    const matrix = new THREE.Object3D();
    const color = new THREE.Color();
    blocks.forEach((block, i) => {
      matrix.position.set(block.x, 7, block.z);
      matrix.rotation.set(0, -block.angle, 0);
      matrix.updateMatrix();
      mesh.setMatrixAt(i, matrix.matrix);
      mesh.setColorAt(i, color.set(block.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
  }, [blocks]);
  return (
    <instancedMesh
      frustumCulled={false}
      ref={ref}
      args={[undefined, undefined, blocks.length]}
      castShadow
      receiveShadow
    >
      <boxGeometry args={[23, 14, 6]} />
      <meshStandardMaterial roughness={0.5} />
    </instancedMesh>
  );
}

// Low-poly trees, scattered clear of the track and the finish camera.
function Trees() {
  const trunks = useRef<THREE.InstancedMesh>(null);
  const pines = useRef<THREE.InstancedMesh>(null);
  const rounds = useRef<THREE.InstancedMesh>(null);
  const trees = useMemo(() => {
    const rand = random(42);
    const list: { x: number; z: number; size: number; pine: boolean }[] = [];
    const clear = (x: number, z: number) =>
      fromTrack(x, z) > (inField(x, z) ? HALF + 70 : BARRIER + 40) &&
      !(Math.abs(x) < 400 && z < -400 && z > -700) && // the grandstand
      !(Math.abs(x) < 330 && Math.abs(z) < 260) && // the finish camera's view
      list.every((t) => Math.hypot(t.x - x, t.z - z) > 40);
    for (let tries = 0; list.length < 170 && tries < 5000; tries++) {
      const x = (rand() - 0.5) * 2600;
      const z = (rand() - 0.5) * 1700;
      if (clear(x, z))
        list.push({ x, z, size: 0.8 + rand() * 0.7, pine: rand() < 0.55 });
    }
    // A ring of woods further out, so the horizon isn't bare.
    for (let i = 0; i < 260; i++) {
      const a = rand() * Math.PI * 2;
      const r = 1500 + rand() * 900;
      list.push({
        x: Math.cos(a) * r * 1.2,
        z: Math.sin(a) * r * 0.9,
        size: 1.2 + rand() * 1.2,
        pine: rand() < 0.6,
      });
    }
    return list;
  }, []);
  useLayoutEffect(() => {
    const rand = random(9);
    const o = new THREE.Object3D();
    const color = new THREE.Color();
    let p = 0;
    let r = 0;
    trees.forEach((tree, i) => {
      o.position.set(tree.x, 9 * tree.size, tree.z);
      o.rotation.set(0, rand() * Math.PI, 0);
      o.scale.setScalar(tree.size);
      o.updateMatrix();
      trunks.current!.setMatrixAt(i, o.matrix);
      const leaves = tree.pine ? pines.current! : rounds.current!;
      o.position.y = (tree.pine ? 38 : 32) * tree.size;
      o.scale.set(tree.size, tree.size * (0.9 + rand() * 0.3), tree.size);
      o.updateMatrix();
      const index = tree.pine ? p++ : r++;
      leaves.setMatrixAt(index, o.matrix);
      color.setHSL(
        (tree.pine ? 0.32 : 0.29) + rand() * 0.04,
        0.5 + rand() * 0.2,
        (tree.pine ? 0.2 : 0.25) + rand() * 0.07,
      );
      leaves.setColorAt(index, color);
    });
    pines.current!.count = p;
    rounds.current!.count = r;
    for (const mesh of [trunks, pines, rounds]) {
      mesh.current!.instanceMatrix.needsUpdate = true;
      if (mesh.current!.instanceColor)
        mesh.current!.instanceColor.needsUpdate = true;
    }
  }, [trees]);
  return (
    <group>
      <instancedMesh
        frustumCulled={false}
        ref={trunks}
        args={[undefined, undefined, trees.length]}
        castShadow
      >
        <cylinderGeometry args={[2.2, 3.2, 18, 6]} />
        <meshStandardMaterial color="#5a3e2b" roughness={0.9} />
      </instancedMesh>
      <instancedMesh
        frustumCulled={false}
        ref={pines}
        args={[undefined, undefined, trees.length]}
        castShadow
        receiveShadow
      >
        <coneGeometry args={[17, 46, 7]} />
        <meshStandardMaterial flatShading roughness={0.8} />
      </instancedMesh>
      <instancedMesh
        frustumCulled={false}
        ref={rounds}
        args={[undefined, undefined, trees.length]}
        castShadow
        receiveShadow
      >
        <icosahedronGeometry args={[19, 0]} />
        <meshStandardMaterial flatShading roughness={0.8} />
      </instancedMesh>
    </group>
  );
}

// A small covered stand behind the start/finish straight, full of fans.
const STAND_Z = LINE_Z - BARRIER - 26; // its front edge
const STAND_WIDTH = 520;
const TIERS = 5;
const TIER_DEPTH = 15;
const TIER_RISE = 9;

function Grandstand() {
  const banner = useMemo(
    () => bannerTexture("CONVEX", (STAND_WIDTH + 32) / 18),
    [],
  );
  return (
    <group position={[0, 0, STAND_Z]}>
      {Array.from({ length: TIERS }, (_, i) => (
        <mesh
          key={i}
          position={[
            0,
            ((i + 1) * TIER_RISE) / 2 + 3,
            -i * TIER_DEPTH - TIER_DEPTH / 2,
          ]}
          castShadow
          receiveShadow
        >
          <boxGeometry
            args={[STAND_WIDTH, (i + 1) * TIER_RISE + 6, TIER_DEPTH]}
          />
          <meshStandardMaterial
            color={i % 2 ? "#2a3150" : "#323a5e"}
            roughness={0.7}
          />
        </mesh>
      ))}
      {/* The back wall and the roof, on posts. */}
      <mesh
        position={[0, 55, -TIERS * TIER_DEPTH - 3]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[STAND_WIDTH + 12, 110, 6]} />
        <meshStandardMaterial color="#1b2036" roughness={0.8} />
      </mesh>
      <mesh
        position={[0, 112, -TIERS * TIER_DEPTH * 0.5]}
        rotation={[-0.12, 0, 0]}
        castShadow
      >
        <boxGeometry args={[STAND_WIDTH + 30, 4, TIERS * TIER_DEPTH + 30]} />
        <meshStandardMaterial color="#20253b" roughness={0.6} metalness={0.3} />
      </mesh>
      <mesh position={[0, 113, 10]} rotation={[-0.12, 0, 0]}>
        <boxGeometry args={[STAND_WIDTH + 32, 18, 3]} />
        <meshStandardMaterial
          map={banner}
          roughness={0.5}
          emissive="#ffffff"
          emissiveMap={banner}
          emissiveIntensity={0.35}
        />
      </mesh>
      {[-1, -0.5, 0, 0.5, 1].map((f) => (
        <mesh key={f} position={[(f * STAND_WIDTH) / 2, 56, 6]} castShadow>
          <cylinderGeometry args={[2, 2, 112, 8]} />
          <meshStandardMaterial
            color="#c9ccd6"
            metalness={0.7}
            roughness={0.3}
          />
        </mesh>
      ))}
      <Crowd />
    </group>
  );
}

function Crowd() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const fans = useMemo(() => {
    const rand = random(5);
    const palette = [
      "#F3B01C",
      "#8D2676",
      "#EE342F",
      "#f4f1ea",
      "#3b82f6",
      "#22c55e",
      "#f97316",
    ];
    const list: {
      x: number;
      y: number;
      z: number;
      phase: number;
      color: string;
    }[] = [];
    for (let tier = 0; tier < TIERS; tier++) {
      for (let x = -STAND_WIDTH / 2 + 8; x < STAND_WIDTH / 2 - 8; x += 9) {
        if (rand() < 0.22) continue; // empty seats
        list.push({
          x: x + (rand() - 0.5) * 3,
          y: (tier + 1) * TIER_RISE + 6 + 5,
          z: -tier * TIER_DEPTH - TIER_DEPTH / 2,
          phase: rand() * Math.PI * 2,
          color: palette[Math.floor(rand() * palette.length)],
        });
      }
    }
    return list;
  }, []);
  useLayoutEffect(() => {
    const color = new THREE.Color();
    fans.forEach((fan, i) => ref.current!.setColorAt(i, color.set(fan.color)));
    ref.current!.instanceColor!.needsUpdate = true;
  }, [fans]);
  // A gentle bounce, so the stand feels alive.
  const o = useMemo(() => new THREE.Object3D(), []);
  useFrame(({ clock }) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = clock.elapsedTime;
    fans.forEach((fan, i) => {
      const bounce = Math.max(0, Math.sin(t * 3 + fan.phase)) ** 4 * 2.5;
      o.position.set(fan.x, fan.y + bounce, fan.z);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, fans.length]}
      castShadow
      frustumCulled={false}
    >
      <capsuleGeometry args={[2.6, 4, 3, 6]} />
      <meshStandardMaterial roughness={0.7} />
    </instancedMesh>
  );
}

// The gantry over the line hangs off one post on the outside, so nothing
// stands between the finish camera and the line.
function Gantry() {
  // A box's faces go +x, -x, +y, -y, +z, -z: the banner faces both ways
  // along the track, with yellow edges.
  const faces = useMemo(() => {
    const banner = bannerTexture("FINISH", 160 / 24);
    const sign = new THREE.MeshStandardMaterial({
      map: banner,
      emissive: "#ffffff",
      emissiveMap: banner,
      emissiveIntensity: 0.35,
      roughness: 0.45,
    });
    const edge = new THREE.MeshStandardMaterial({ color: "#F3B01C" });
    return [sign, sign, edge, edge, edge, edge];
  }, []);
  const stripe = useMemo(() => chequerTexture(2, 22), []);
  const postZ = LINE_Z - HALF - 32;
  const span = TRACK_WIDTH + 60;
  const beamY = 92;
  return (
    <group>
      <RoundedBox
        args={[12, beamY + 12, 12]}
        radius={2}
        position={[0, (beamY + 12) / 2, postZ]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial
          color="#262a3a"
          metalness={0.6}
          roughness={0.35}
        />
      </RoundedBox>
      <RoundedBox
        args={[10, 12, span]}
        radius={2}
        position={[0, beamY + 6, postZ + span / 2 - 6]}
        castShadow
      >
        <meshStandardMaterial
          color="#262a3a"
          metalness={0.6}
          roughness={0.35}
        />
      </RoundedBox>
      {/* The banner, readable from both directions. */}
      <mesh
        position={[0, beamY - 12, postZ + span / 2 + 4]}
        material={faces}
        castShadow
      >
        <boxGeometry args={[3, 24, span - 40]} />
      </mesh>
      {/* Start lights, glowing Convex red. */}
      {[0, 1, 2, 3, 4].map((i) => (
        <mesh key={i} position={[-6, beamY + 6, LINE_Z - 40 + i * 20]}>
          <sphereGeometry args={[3.2, 16, 12]} />
          <meshStandardMaterial
            color="#EE342F"
            emissive="#EE342F"
            emissiveIntensity={14}
            toneMapped={false}
          />
        </mesh>
      ))}
      {/* A chequered stripe up the post marks the line from the side. */}
      <mesh position={[0, beamY / 2, postZ + 6.2]}>
        <planeGeometry args={[8, beamY]} />
        <meshStandardMaterial map={stripe} roughness={0.4} />
      </mesh>
    </group>
  );
}

// Floodlight towers at the corners, glowing over the dusk: each throws a
// pool of warm light on the track, with a halo and a faint beam in the air.
const LAMP_Y = 224;
const LAMPS: [number, number][] = [
  [-640, -560],
  [640, -560],
  [-640, 560],
  [640, 560],
];

function glowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.12, "rgba(255,240,210,0.7)");
  g.addColorStop(0.4, "rgba(255,200,140,0.18)");
  g.addColorStop(1, "rgba(255,180,120,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

function Floodlights() {
  const parts = useMemo(() => {
    const halo = new THREE.SpriteMaterial({
      map: glowTexture(),
      color: new THREE.Color("#ffe2b0").multiplyScalar(2.2),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    // A cone of light, brightest at the lamp, fading to nothing below.
    const beam = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: { color: { value: new THREE.Color("#ffd9a0") } },
      vertexShader: /* glsl */ `
        varying float vAlong;
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vAlong = uv.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 color;
        varying float vAlong;
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          float face = abs(dot(normalize(vNormal), normalize(vView)));
          float a = pow(clamp(vAlong, 0.0, 1.0), 2.2) * face * 0.16;
          gl_FragColor = vec4(color * a, 1.0);
        }`,
    });
    const lamps = LAMPS.map(([x, z]) => {
      const head = new THREE.Vector3(x, LAMP_Y, z);
      const aim = new THREE.Vector3(x * 0.62, 0, z * 0.5);
      const length = head.distanceTo(aim);
      const middle = head.clone().lerp(aim, 0.5);
      const turn = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        head.clone().sub(aim).normalize(),
      );
      const light = new THREE.SpotLight("#ffe4bd", 4.5e5, 0, 0.6, 0.75, 2);
      light.position.copy(head);
      light.target.position.copy(aim);
      return { x, z, light, length, middle, turn };
    });
    return { halo, beam, lamps };
  }, []);
  return (
    <group>
      {parts.lamps.map(({ x, z, light, length, middle, turn }) => {
        const facing = Math.atan2(-x, -z);
        return (
          <group key={`${x}${z}`}>
            <group position={[x, 0, z]} rotation={[0, facing, 0]}>
              <mesh position={[0, 110, 0]} castShadow>
                <cylinderGeometry args={[2.5, 4, 220, 8]} />
                <meshStandardMaterial
                  color="#9aa0b0"
                  metalness={0.7}
                  roughness={0.35}
                />
              </mesh>
              <mesh
                position={[0, LAMP_Y, 2]}
                rotation={[0.35, 0, 0]}
                castShadow
              >
                <boxGeometry args={[44, 22, 5]} />
                <meshStandardMaterial
                  color="#2a2e3c"
                  metalness={0.5}
                  roughness={0.4}
                />
              </mesh>
              <mesh position={[0, LAMP_Y, 5]} rotation={[0.35, 0, 0]}>
                <planeGeometry args={[40, 18]} />
                <meshStandardMaterial
                  color="#fff3d6"
                  emissive="#fff1cc"
                  emissiveIntensity={9}
                  toneMapped={false}
                />
              </mesh>
              <sprite
                position={[0, LAMP_Y, 12]}
                scale={[150, 150, 1]}
                material={parts.halo}
              />
            </group>
            <primitive object={light} />
            <primitive object={light.target} />
            <mesh
              position={middle}
              quaternion={turn}
              material={parts.beam}
              renderOrder={2}
            >
              <coneGeometry
                args={[length * Math.tan(0.5), length, 32, 1, true]}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

export default memo(function RacerWorld() {
  return (
    <group>
      <Sky />
      <Ground />
      <Track />
      <Barriers />
      <Trees />
      <Grandstand />
      <Gantry />
      <Floodlights />
    </group>
  );
});
