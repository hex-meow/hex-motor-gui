import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import "./BasePoseViewer.css";

interface BasePoseViewerProps {
  connected: boolean;
  poseX: number;
  poseY: number;
  theta: number;
  vx: number;
  vy: number;
  wz: number;
}

const MAX_TRAIL = 500;
const VELOCITY_ARROW_Y = 0.48;

export function BasePoseViewer({ connected, poseX, poseY, theta, vx, vy, wz }: BasePoseViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const robotRef = useRef<THREE.Group | null>(null);
  const velocityRef = useRef<THREE.ArrowHelper | null>(null);
  const yawLeftRef = useRef<THREE.Group | null>(null);
  const yawRightRef = useRef<THREE.Group | null>(null);
  const trailRef = useRef<THREE.Line | null>(null);
  const trailPointsRef = useRef<THREE.Vector3[]>([]);
  const lastTrailRef = useRef<THREE.Vector3 | null>(null);
  const cameraTargetRef = useRef<THREE.Vector3 | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 120);
    camera.position.set(3.8, 4.4, 4.6);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    rendererRef.current = renderer;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = false;
    controls.minDistance = 2.2;
    controls.maxDistance = 14;
    controls.minPolarAngle = 0.16;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.target.set(0, 0, 0);
    controls.addEventListener("change", renderScene);
    controls.update();
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(3, 6, 5);
    scene.add(key);

    const grid = new THREE.GridHelper(12, 24, 0x395066, 0x1d2630);
    grid.position.y = -0.015;
    scene.add(grid);

    const axes = new THREE.Group();
    axes.add(makeAxis(0xe75b2b, new THREE.Vector3(1, 0, 0), "+X"));
    axes.add(makeAxis(0x63d18f, new THREE.Vector3(0, 0, 1), "+Y"));
    axes.position.set(-4.8, 0.02, -4.8);
    scene.add(axes);

    const trailMat = new THREE.LineBasicMaterial({ color: 0xe75b2b, transparent: true, opacity: 0.82 });
    const trail = new THREE.Line(new THREE.BufferGeometry(), trailMat);
    trailRef.current = trail;
    scene.add(trail);

    const robot = makeRobot();
    robotRef.current = robot;
    scene.add(robot);

    const velocity = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, VELOCITY_ARROW_Y, 0), 0.01, 0xff8a5f, 0.16, 0.08);
    velocityRef.current = velocity;
    robot.add(velocity);

    const yawLeft = makeYawIndicator(1);
    const yawRight = makeYawIndicator(-1);
    yawLeftRef.current = yawLeft;
    yawRightRef.current = yawRight;
    robot.add(yawLeft, yawRight);

    const resize = () => {
      const rect = mount.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderScene();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    return () => {
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      renderer.domElement.remove();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      robotRef.current = null;
      velocityRef.current = null;
      yawLeftRef.current = null;
      yawRightRef.current = null;
      trailRef.current = null;
      cameraTargetRef.current = null;
    };
  }, []);

  useEffect(() => {
    const robot = robotRef.current;
    const velocity = velocityRef.current;
    const yawLeft = yawLeftRef.current;
    const yawRight = yawRightRef.current;
    if (!robot || !velocity || !yawLeft || !yawRight) return;

    robot.position.set(poseX, 0, poseY);
    robot.rotation.y = -theta;

    const speed = Math.hypot(vx, vy);
    if (speed > 1e-4) {
      velocity.visible = true;
      velocity.position.set(0, VELOCITY_ARROW_Y, 0);
      velocity.setDirection(new THREE.Vector3(vx, 0, vy).normalize());
      velocity.setLength(Math.min(1.25, 0.35 + speed * 1.6), 0.18, 0.09);
    } else {
      velocity.visible = false;
    }

    const yawSpeed = Math.abs(wz);
    yawLeft.visible = wz > 1e-4;
    yawRight.visible = wz < -1e-4;
    const yawScale = 0.86 + Math.min(0.18, yawSpeed * 0.08);
    yawLeft.scale.setScalar(yawScale);
    yawRight.scale.setScalar(yawScale);

    const p = new THREE.Vector3(poseX, 0.035, poseY);
    const last = lastTrailRef.current;
    if (!connected) {
      trailPointsRef.current = [p.clone()];
      lastTrailRef.current = p.clone();
    } else if (!last || last.distanceToSquared(p) > 0.0004) {
      const pts = trailPointsRef.current;
      pts.push(p.clone());
      if (pts.length > MAX_TRAIL) pts.splice(0, pts.length - MAX_TRAIL);
      lastTrailRef.current = p.clone();
    }
    updateTrail();
    updateCameraTarget(poseX, poseY);
    renderScene();
  }, [connected, poseX, poseY, theta, vx, vy, wz]);

  const renderScene = () => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (renderer && scene && camera) renderer.render(scene, camera);
  };

  const updateTrail = () => {
    const trail = trailRef.current;
    if (!trail) return;
    trail.geometry.dispose();
    trail.geometry = new THREE.BufferGeometry().setFromPoints(trailPointsRef.current);
  };

  const updateCameraTarget = (x: number, y: number) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const nextTarget = new THREE.Vector3(x, 0, y);
    const previousTarget = cameraTargetRef.current ?? controls.target.clone();
    const delta = nextTarget.clone().sub(previousTarget);
    camera.position.add(delta);
    controls.target.copy(nextTarget);
    cameraTargetRef.current = nextTarget;
    controls.update();
  };

  return <div ref={mountRef} className="base-pose-viewer" />;
}

function makeRobot(): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x243244, metalness: 0.2, roughness: 0.55 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xe75b2b, emissive: 0x4a1609, metalness: 0.1, roughness: 0.4 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x0b0e13, roughness: 0.8 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.16, 48), bodyMat);
  body.position.y = 0.11;
  g.add(body);

  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.045, 48), edgeMat);
  top.position.y = 0.22;
  g.add(top);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.34, 32), edgeMat);
  nose.rotation.z = -Math.PI / 2;
  nose.position.set(0.48, 0.18, 0);
  g.add(nose);

  for (let i = 0; i < 3; i += 1) {
    const a = i * (Math.PI * 2 / 3) + Math.PI / 6;
    const wheel = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.32), darkMat);
    wheel.position.set(Math.cos(a) * 0.36, 0.07, Math.sin(a) * 0.36);
    wheel.rotation.y = -a;
    g.add(wheel);
  }

  return g;
}

function makeAxis(color: number, dir: THREE.Vector3, label: string): THREE.Group {
  const g = new THREE.Group();
  const arrow = new THREE.ArrowHelper(dir.normalize(), new THREE.Vector3(0, 0, 0), 0.9, color, 0.16, 0.08);
  g.add(arrow);

  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 48;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    ctx.font = "700 24px ui-sans-serif, system-ui";
    ctx.fillText(label, 8, 32);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.position.copy(dir.clone().multiplyScalar(1.05));
  sprite.position.y = 0.06;
  sprite.scale.set(0.7, 0.26, 1);
  g.add(sprite);
  return g;
}

function makeYawIndicator(sign: 1 | -1): THREE.Group {
  const color = 0xffc857;
  const radius = 0.62;
  const y = 0.34;
  const start = sign > 0 ? -Math.PI * 0.72 : Math.PI * 0.72;
  const span = sign > 0 ? Math.PI * 1.42 : -Math.PI * 1.42;
  const points: THREE.Vector3[] = [];

  for (let i = 0; i <= 48; i += 1) {
    const a = start + span * (i / 48);
    points.push(new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius));
  }

  const g = new THREE.Group();
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 }),
  );
  g.add(line);

  const end = points[points.length - 1];
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.07, 0.16, 24),
    new THREE.MeshStandardMaterial({ color, emissive: 0x5a3b00, roughness: 0.35 }),
  );
  const tangentAngle = start + span + (sign > 0 ? Math.PI / 2 : -Math.PI / 2);
  cone.position.copy(end);
  cone.rotation.z = -Math.PI / 2;
  cone.rotation.y = -tangentAngle;
  g.add(cone);

  g.visible = false;
  return g;
}
