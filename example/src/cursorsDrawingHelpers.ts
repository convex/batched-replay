// Helpers shared by the 3D cursors and drawing scenes.
import * as THREE from "three";

// colorFor() gives "hsl(h 80% 60%)", which THREE.Color can't parse.
export function threeColor(css: string, target = new THREE.Color()) {
  const [h, s, l] = (css.match(/[\d.]+/g) ?? ["0", "0", "50"]).map(Number);
  return target.setHSL(h / 360, s / 100, l / 100, THREE.SRGBColorSpace);
}

// Where a pointer event's ray meets the horizontal plane at `height`.
export function pointOnPlane(
  camera: THREE.Camera,
  element: HTMLElement,
  clientX: number,
  clientY: number,
  height: number,
) {
  const rect = element.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -height);
  return ray.ray.intersectPlane(plane, new THREE.Vector3());
}

// A canvas texture drawn once, for procedural surfaces.
export function paintTexture(
  size: number,
  paint: (ctx: CanvasRenderingContext2D, size: number) => void,
  colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace,
) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  paint(canvas.getContext("2d")!, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = colorSpace;
  texture.anisotropy = 8;
  return texture;
}
