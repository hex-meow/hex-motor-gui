// 3D orientation view: a flat "board" with a body-frame axis triad (X=red,
// Y=green, Z=blue) whose orientation tracks the IMU quaternion every frame.
// Z-up scene with a fixed world gravity arrow (down) for reference, so you can
// read tilt and yaw at a glance. The quaternion is [w, x, y, z]; three.js wants
// (x, y, z, w).
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

interface Props {
  quaternion: [number, number, number, number]; // [w, x, y, z]
}

export function ImuViewer({ quaternion }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  // Latest quaternion, read inside the render loop (smooth, render-cadence
  // independent). Updated every render without re-running the init effect.
  const quatRef = useRef<[number, number, number, number]>([1, 0, 0, 0]);
  quatRef.current = quaternion;

  useEffect(() => {
    const mount = mountRef.current!;
    const H = 320;
    const W = mount.clientWidth || 600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1d23);
    const camera = new THREE.PerspectiveCamera(50, W / H, 0.01, 100);
    camera.position.set(2.4, -2.8, 1.9);
    camera.up.set(0, 0, 1); // Z-up
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);
    controls.enablePan = false;

    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(1, 1, 2);
    scene.add(dir);

    const grid = new THREE.GridHelper(4, 16, 0x444444, 0x2a2a2a).rotateX(Math.PI / 2);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.3;
    scene.add(grid);

    // World gravity reference: always points down (world −Z).
    const gArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(0, 0, 0),
      1.3,
      0xff5555,
      0.18,
      0.1,
    );
    scene.add(gArrow);

    // IMU body: a flat board + a light strip on the +X edge so yaw is legible,
    // plus a body-frame axis triad.
    const body = new THREE.Group();
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 1.05, 0.12),
      new THREE.MeshPhongMaterial({ color: 0x2f7d32 }),
    );
    body.add(board);
    const xMark = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 1.05, 0.13),
      new THREE.MeshPhongMaterial({ color: 0xe0e0e0 }),
    );
    xMark.position.set(0.71, 0, 0);
    body.add(xMark);
    body.add(new THREE.AxesHelper(1.15));
    scene.add(body);

    let raf = 0;
    const animate = () => {
      const [w, x, y, z] = quatRef.current;
      body.quaternion.set(x, y, z, w);
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth || 600;
      camera.aspect = w / H;
      camera.updateProjectionMatrix();
      renderer.setSize(w, H);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mountRef} style={{ width: "100%", height: 320, borderRadius: 8, overflow: "hidden" }} />;
}
