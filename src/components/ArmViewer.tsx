// 3D 数字孪生:three.js + urdf-loader 加载 firefly URDF,按 joint_state 实时更新关节角。
// previewQ 非空时叠加一个半透明“幽灵臂”到目标位姿(预设悬浮预览,先看后动)。
// TODO:目前 URDF+STL 捆在前端 public/urdf/(写死 firefly)。多型号后改成从机器人 arm/urdf
//       动态取(后端解析 package:// 供网格),见 zenoh_arm / 02-arm-api 的 UrdfResource。
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import URDFLoader from "urdf-loader";
import type { URDFRobot } from "urdf-loader";

interface Props {
  q: number[];
  gravity: [number, number, number];
  jointNames: string[];
  previewQ?: number[] | null; // 悬浮预设时的目标位姿(幽灵臂)
}

export function ArmViewer({ q, gravity, jointNames, previewQ }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const robotRef = useRef<URDFRobot | null>(null);
  const ghostRef = useRef<URDFRobot | null>(null);
  const arrowRef = useRef<THREE.ArrowHelper | null>(null);
  const autoJointsRef = useRef<string[]>([]);

  useEffect(() => {
    const mount = mountRef.current!;
    const H = 440;
    const W = mount.clientWidth || 600;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1d23);
    const camera = new THREE.PerspectiveCamera(50, W / H, 0.01, 100);
    camera.position.set(0.7, -0.9, 0.7);
    camera.up.set(0, 0, 1); // URDF 是 Z-up
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0); // 始终绕零点(基座原点)旋转/缩放

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(1, 1, 2);
    scene.add(dir);
    const grid = new THREE.GridHelper(2, 20, 0x444444, 0x2a2a2a).rotateX(Math.PI / 2); // XY 平面(Z-up)
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.3;
    scene.add(grid);

    // 重力箭头:放在地板下方,且 depthTest=false → 不被机械臂/地板遮挡,始终可见。
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -0.04), 0.34, 0xff5555, 0.08, 0.05);
    arrow.position.set(0, 0, -0.04);
    [arrow.line.material, arrow.cone.material].forEach((m) => { (m as THREE.Material).depthTest = false; (m as THREE.Material).transparent = true; });
    arrow.renderOrder = 999;
    scene.add(arrow);
    arrowRef.current = arrow;

    const loader = new URDFLoader();
    loader.packages = { xpkg_urdf_firefly_y6: "/urdf" };
    // ⚠️ 真实签名是 (path, manager, material, onComplete) —— 4 个参数(.d.ts 漏了 material)。
    (loader as any).loadMeshCb = (
      url: string,
      manager: THREE.LoadingManager,
      _material: THREE.Material,
      onComplete: (obj: THREE.Object3D | null, err?: Error) => void,
    ) => {
      new STLLoader(manager).load(
        url,
        (geom) => onComplete(new THREE.Mesh(geom, new THREE.MeshPhongMaterial({ color: 0xbfc4cc }))),
        undefined,
        (err) => onComplete(null, err as Error),
      );
    };

    loader.loadAsync("/urdf/firefly.urdf").then((robot) => {
      robotRef.current = robot;
      autoJointsRef.current = Object.keys(robot.joints).filter((n) => (robot.joints[n] as any).jointType !== "fixed");
      scene.add(robot);
    }).catch((e) => console.error("URDF load failed", e));

    // 幽灵臂(预设预览):半透明绿色,默认隐藏。
    loader.loadAsync("/urdf/firefly.urdf").then((ghost) => {
      ghost.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          (o as THREE.Mesh).material = new THREE.MeshPhongMaterial({ color: 0x44dd88, transparent: true, opacity: 0.35, depthWrite: false });
        }
      });
      ghost.visible = false;
      ghostRef.current = ghost;
      scene.add(ghost);
    }).catch(() => {});

    let raf = 0;
    const animate = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(animate); };
    animate();
    const onResize = () => {
      const w = mount.clientWidth || 600;
      camera.aspect = w / H; camera.updateProjectionMatrix(); renderer.setSize(w, H);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  // 实时关节角
  useEffect(() => {
    const robot = robotRef.current;
    if (!robot) return;
    const names = jointNames.length ? jointNames : autoJointsRef.current;
    names.forEach((n, i) => { if (robot.joints[n]) robot.setJointValue(n, q[i] ?? 0); });
  }, [q, jointNames]);

  // 幽灵臂:预设悬浮预览
  useEffect(() => {
    const ghost = ghostRef.current;
    if (!ghost) return;
    if (previewQ && previewQ.length) {
      const names = jointNames.length ? jointNames : autoJointsRef.current;
      names.forEach((n, i) => { if (ghost.joints[n]) ghost.setJointValue(n, previewQ[i] ?? 0); });
      ghost.visible = true;
    } else {
      ghost.visible = false;
    }
  }, [previewQ, jointNames]);

  // 重力箭头方向/长度
  useEffect(() => {
    const arrow = arrowRef.current;
    if (!arrow) return;
    const g = new THREE.Vector3(gravity[0], gravity[1], gravity[2]);
    const len = g.length();
    if (len > 1e-6) {
      arrow.setDirection(g.clone().normalize());
      arrow.setLength(0.12 + 0.22 * Math.min(len / 9.81, 1), 0.05, 0.03);
    }
  }, [gravity]);

  return <div ref={mountRef} style={{ width: "100%", height: 440, borderRadius: 8, overflow: "hidden" }} />;
}
