// The look shared by the 3D cursors and drawing demos: studio lighting,
// light post-processing, and a camera that fits a flat surface to the window.
// Nothing here knows about batched replay.
import { useLayoutEffect } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import {
  Bloom,
  EffectComposer,
  ToneMapping,
  Vignette,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";

// Image-based lighting from soft boxes, so glossy things have something to
// reflect: a big overhead softbox, a warm key, a cool rim and a hint of
// Convex yellow.
export function StudioEnvironment({ intensity = 0.6 }: { intensity?: number }) {
  return (
    <Environment resolution={256} frames={1} environmentIntensity={intensity}>
      <color attach="background" args={["#05060a"]} />
      <Lightformer
        form="rect"
        intensity={2.2}
        color="#ffffff"
        position={[0, 8, 0]}
        rotation-x={Math.PI / 2}
        scale={[14, 8, 1]}
      />
      <Lightformer
        form="rect"
        intensity={3}
        color="#ffb46e"
        position={[-9, 4, 5]}
        scale={[7, 4, 1]}
        target={[0, 0, 0]}
      />
      <Lightformer
        form="rect"
        intensity={2.4}
        color="#7c96ff"
        position={[9, 3, -6]}
        scale={[7, 3, 1]}
        target={[0, 0, 0]}
      />
      <Lightformer
        form="ring"
        intensity={1.6}
        color="#F3B01C"
        position={[0, 4, 9]}
        scale={3}
        target={[0, 0, 0]}
      />
      <Lightformer
        form="circle"
        intensity={1.2}
        color="#8D2676"
        position={[6, 2, 8]}
        scale={4}
        target={[0, 0, 0]}
      />
    </Environment>
  );
}

// Bloom on the bright bits, ACES Filmic tone mapping, a vignette, and
// multisampled antialiasing.
export function PostFX({ bloomThreshold = 0.8, bloom = 0.6, vignette = 0.62 }) {
  return (
    <EffectComposer multisampling={4}>
      <Bloom
        mipmapBlur
        intensity={bloom}
        luminanceThreshold={bloomThreshold}
        luminanceSmoothing={0.25}
      />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Vignette offset={0.28} darkness={vignette} />
    </EffectComposer>
  );
}

type Fit = {
  // The point the camera looks at, and the direction it looks from.
  target: [number, number, number];
  from: [number, number, number];
  // World points that must all be in view.
  points: THREE.Vector3[];
  // Where they should land, in normalized device coordinates:
  // [left, right, bottom, top].
  box: (size: { width: number; height: number }) => number[];
};

// Moves the camera along a fixed direction until the points just fit the
// box, then shifts the view so they're centred in it. Runs again on resize.
export function FitCamera({ target, from, points, box }: Fit) {
  const get = useThree((s) => s.get);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  useLayoutEffect(() => {
    const camera = get().camera;
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const [left, right, bottom, top] = box({ width, height });
    const aim = new THREE.Vector3(...target);
    const direction = new THREE.Vector3(...from).normalize();
    const v = new THREE.Vector3();
    const place = (distance: number) => {
      camera.position.copy(aim).addScaledVector(direction, distance);
      camera.lookAt(aim);
      camera.updateMatrixWorld();
      let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
      for (const p of points) {
        v.copy(p).project(camera);
        [x0, x1] = [Math.min(x0, v.x), Math.max(x1, v.x)];
        [y0, y1] = [Math.min(y0, v.y), Math.max(y1, v.y)];
      }
      return { x0, x1, y0, y1 };
    };
    camera.clearViewOffset();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    let [near, far] = [1, 400];
    for (let i = 0; i < 40; i++) {
      const mid = (near + far) / 2;
      const b = place(mid);
      const fits = b.x1 - b.x0 <= right - left && b.y1 - b.y0 <= top - bottom;
      if (fits) far = mid;
      else near = mid;
    }
    const b = place(far);
    const dx = (left + right) / 2 - (b.x0 + b.x1) / 2;
    const dy = (bottom + top) / 2 - (b.y0 + b.y1) / 2;
    camera.setViewOffset(
      width,
      height,
      (-dx / 2) * width,
      (dy / 2) * height,
      width,
      height,
    );
  }, [get, width, height, target, from, points, box]);
  return null;
}
