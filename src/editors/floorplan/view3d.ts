// Lazy 3D renderer for a floor plan. Three.js is loaded from esm.sh at runtime
// (already allowlisted in script-src/connect-src — see public/_headers) so it
// never enters the main bundle. The same FloorPlan model that drives the 2D
// canvas is extruded here: walls become boxes of their real height/thickness,
// furniture becomes to-scale coloured blocks. Metres map 1:1 to world units.
import type { FloorPlan } from './model';
import { wallLength } from './model';

export interface View3D { dispose(): void }

// Imported dynamically; typed loosely since three is pulled from a URL.
type Three = typeof import('three');

export async function mount3D(host: HTMLElement, plan: FloorPlan): Promise<View3D> {
  const THREE = (await import(/* @vite-ignore */ 'https://esm.sh/three@0.160.0')) as Three;
  const { OrbitControls } = (await import(
    /* @vite-ignore */ 'https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js'
  )) as { OrbitControls: new (cam: unknown, dom: HTMLElement) => { update(): void; dispose(): void; target: { set(x: number, y: number, z: number): void } } };

  const width = host.clientWidth || 800;
  const height = host.clientHeight || 600;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e9eef5');

  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);
  renderer.shadowMap.enabled = true;
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
  host.appendChild(renderer.domElement);

  // Lighting.
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(6, 14, 8);
  sun.castShadow = true;
  scene.add(sun);

  // Centre the geometry around the origin for comfortable orbiting.
  let cx = 0, cy = 0, n = 0;
  for (const w of plan.walls) { cx += (w.x1 + w.x2) / 2; cy += (w.y1 + w.y2) / 2; n++; }
  for (const f of plan.furniture) { cx += f.x; cy += f.y; n++; }
  if (n) { cx /= n; cy /= n; }

  const root = new THREE.Group();
  root.position.set(-cx, 0, -cy);
  scene.add(root);

  // Ground.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: '#cfd8dc' }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, -0.01, cy);
  ground.receiveShadow = true;
  scene.add(ground);

  // Walls: a box per segment, rotated to the segment's heading. Note the 2D
  // plan's y axis maps to world z.
  const wallMat = new THREE.MeshStandardMaterial({ color: '#f5f5f0' });
  for (const w of plan.walls) {
    const len = wallLength(w);
    if (len <= 0) continue;
    const geo = new THREE.BoxGeometry(len, w.height, w.thickness);
    const mesh = new THREE.Mesh(geo, wallMat);
    mesh.position.set((w.x1 + w.x2) / 2, w.height / 2, (w.y1 + w.y2) / 2);
    mesh.rotation.y = -Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  // Furniture: coloured blocks sized to footprint × height.
  for (const f of plan.furniture) {
    const geo = new THREE.BoxGeometry(f.w, f.h, f.d);
    const mat = new THREE.MeshStandardMaterial({ color: f.color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(f.x, f.h / 2, f.y);
    mesh.rotation.y = -(f.rotation * Math.PI) / 180;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  // Frame the whole plan: distance from the plan radius, widened for portrait.
  let radius = 2.5;
  for (const w of plan.walls) {
    radius = Math.max(radius, Math.hypot((w.x1 - cx), (w.y1 - cy)), Math.hypot((w.x2 - cx), (w.y2 - cy)));
  }
  for (const f of plan.furniture) radius = Math.max(radius, Math.hypot(f.x - cx, f.y - cy) + Math.max(f.w, f.d) / 2);
  const frame = () => {
    const aspect = (host.clientWidth || width) / (host.clientHeight || height);
    const vfov = (camera.fov * Math.PI) / 180;
    const fitH = Math.min(1, aspect);
    const dist = (radius * 1.25) / Math.tan(vfov / 2) / fitH;
    camera.position.set(dist * 0.45, dist * 0.7, dist * 0.55);
  };
  frame();

  const controls = new OrbitControls(camera, renderer.domElement) as unknown as {
    update(): void; dispose(): void; target: { set(x: number, y: number, z: number): void };
    addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void;
    maxPolarAngle: number; minDistance: number; maxDistance: number; enableDamping: boolean;
  };
  controls.target.set(0, 0.8, 0);
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.minDistance = 1.5;
  controls.maxDistance = radius * 8 + 20;
  controls.update();

  // Render on demand (camera moves / resize) instead of a continuous 60fps loop.
  let raf = 0;
  const render = () => { raf = 0; renderer.render(scene, camera); };
  const requestRender = () => { if (!raf) raf = requestAnimationFrame(render); };
  controls.addEventListener('change', requestRender);
  render();

  const onResize = () => {
    const w = host.clientWidth || width;
    const h = host.clientHeight || height;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    requestRender();
  };
  window.addEventListener('resize', onResize);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  ro?.observe(host);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      controls.removeEventListener('change', requestRender);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
