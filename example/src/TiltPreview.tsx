// A small 3D board on the phone that tilts as you do, so you can see what
// you're sending. Kept light for phones: no shadows maps, no post-processing.
import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Lightformer, RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { blobTexture, woodTexture } from "./wood";
import "./marble.css";

type Tilt = { beta: number; gamma: number };
const DEG = Math.PI / 180;
const SIZE = 6;

function MiniBoard({ tilt, maxTilt }: { tilt: Tilt; maxTilt: number }) {
  const target = useRef(tilt);
  useEffect(() => {
    target.current = tilt;
  });
  const textures = useMemo(() => {
    const floor = woodTexture({
      width: 512,
      height: 512,
      base: "#d6a86c",
      dark: "#8a5a2b",
      light: "#f2cf98",
      seed: 11,
      density: 6,
      // Rings like a spirit level's, round the middle.
      paint: (ctx) => {
        ctx.strokeStyle = "#3a2212";
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 3;
        for (const r of [60, 130, 200]) {
          ctx.beginPath();
          ctx.arc(256, 256, r, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(256, 30);
        ctx.lineTo(256, 482);
        ctx.moveTo(30, 256);
        ctx.lineTo(482, 256);
        ctx.stroke();
        ctx.globalAlpha = 1;
      },
    });
    const frame = woodTexture({
      width: 512,
      height: 256,
      base: "#6b3f22",
      dark: "#2e1709",
      light: "#9a6338",
      seed: 9,
      density: 6,
    });
    return { floor, frame, blob: blobTexture() };
  }, []);

  const board = useRef<THREE.Group>(null);
  const ball = useRef<THREE.Mesh>(null);
  const shadow = useRef<THREE.Mesh>(null);
  const state = useRef({ x: 0, z: 0, vx: 0, vz: 0, bx: 0, bz: 0 });
  useFrame((_, delta) => {
    const dt = Math.min(delta, 1 / 30);
    const s = state.current;
    const { beta, gamma } = target.current;
    const k = 160;
    const c = 2 * Math.sqrt(k) * 0.75;
    s.vx += (k * (beta * DEG * 0.7 - s.x) - c * s.vx) * dt;
    s.vz += (k * (-gamma * DEG * 0.7 - s.z) - c * s.vz) * dt;
    s.x += s.vx * dt;
    s.z += s.vz * dt;
    board.current?.rotation.set(s.x, 0, s.z);
    // The ball settles towards the low side, like a bubble in reverse.
    const reach = SIZE / 2 - 0.95;
    const ease = 1 - Math.exp(-dt * 7);
    s.bx += ((gamma / maxTilt) * reach - s.bx) * ease;
    s.bz += ((beta / maxTilt) * reach - s.bz) * ease;
    ball.current?.position.set(s.bx, 0.38, s.bz);
    shadow.current?.position.set(s.bx, 0.01, s.bz);
  });

  return (
    <group ref={board}>
      <mesh position={[0, -0.2, 0]}>
        <boxGeometry args={[SIZE, 0.4, SIZE]} />
        <meshPhysicalMaterial
          map={textures.floor}
          roughness={0.5}
          clearcoat={0.6}
          clearcoatRoughness={0.3}
        />
      </mesh>
      {[
        [0, -SIZE / 2 + 0.25, SIZE, 0.5],
        [0, SIZE / 2 - 0.25, SIZE, 0.5],
        [-SIZE / 2 + 0.25, 0, 0.5, SIZE - 1],
        [SIZE / 2 - 0.25, 0, 0.5, SIZE - 1],
      ].map(([x, z, w, d], i) => (
        <RoundedBox
          key={i}
          args={[w, 0.7, d]}
          radius={0.08}
          smoothness={2}
          position={[x, 0.35, z]}
        >
          <meshPhysicalMaterial
            map={textures.frame}
            roughness={0.45}
            clearcoat={0.9}
            clearcoatRoughness={0.2}
          />
        </RoundedBox>
      ))}
      <mesh rotation-x={Math.PI / 2} position={[0, 0.01, 0]}>
        <torusGeometry args={[0.5, 0.025, 8, 40]} />
        <meshBasicMaterial color="#F3B01C" toneMapped={false} />
      </mesh>
      <mesh ref={ball}>
        <sphereGeometry args={[0.38, 48, 32]} />
        <meshStandardMaterial color="#eef1f5" metalness={1} roughness={0.06} />
      </mesh>
      <mesh ref={shadow} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[1.3, 1.3]} />
        <meshBasicMaterial map={textures.blob} transparent depthWrite={false} />
      </mesh>
    </group>
  );
}

export default function TiltPreview({
  tilt,
  maxTilt,
}: {
  tilt: Tilt;
  maxTilt: number;
}) {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 10.4, 7], fov: 38 }}
      gl={{ antialias: true, alpha: true }}
      onCreated={({ camera }) => camera.lookAt(0, -0.4, 0.2)}
    >
      <directionalLight position={[-4, 8, 5]} color="#ffd7a6" intensity={2.2} />
      <directionalLight position={[5, 3, -6]} color="#8fb2ff" intensity={1.6} />
      <Environment resolution={64} frames={1}>
        <color attach="background" args={["#56607a"]} />
        <Lightformer
          color="#f4f1ea"
          intensity={1.6}
          position={[0, 7, 7]}
          scale={[8, 4, 1]}
        />
        <Lightformer
          color="#ffe1b5"
          intensity={3}
          position={[-5, 6, 4]}
          scale={[8, 4, 1]}
        />
        <Lightformer
          color="#8fb0ff"
          intensity={3}
          position={[6, 2, -6]}
          scale={[8, 1, 1]}
        />
        <Lightformer
          color="#8D2676"
          intensity={3}
          position={[-7, 1, -3]}
          scale={[6, 1.5, 1]}
        />
      </Environment>
      <MiniBoard tilt={tilt} maxTilt={maxTilt} />
    </Canvas>
  );
}
