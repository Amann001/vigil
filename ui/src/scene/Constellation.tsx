import { Line, OrbitControls, Stars } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { SERVICES, type Service, type SystemView } from "../lib/types";
import { formatValue, serviceName } from "../lib/words";
import "./constellation.css";

/*
  The shop drawn as a constellation. Each service is a star; each dependency is a thread of
  light along which requests travel as sparks. Everything moves with the real metrics: more
  requests make more sparks, a slow service makes them crawl, failed calls turn them red, and a
  service that stops reporting goes dark.
*/

export type Tone = "calm" | "sodium" | "flare" | "aurora";

export interface Focus {
  service: Service;
  tone: Tone;
}

const POSITIONS: Record<Service, THREE.Vector3> = {
  storefront: new THREE.Vector3(-3.3, 0.15, 0.4),
  orders: new THREE.Vector3(-0.1, 0.55, -0.5),
  payments: new THREE.Vector3(3.1, 1.45, 0.2),
  inventory: new THREE.Vector3(2.2, -1.65, 0.9),
};

const EDGES: [Service, Service][] = [
  ["storefront", "orders"],
  ["orders", "payments"],
  ["orders", "inventory"],
  ["storefront", "inventory"],
];

const COLORS = {
  calm: new THREE.Color("#e8edff"),
  sodium: new THREE.Color("#ffa53d"),
  flare: new THREE.Color("#ff4d5e"),
  aurora: new THREE.Color("#6fe3c8"),
  ember: new THREE.Color("#5a1c26"),
  thread: new THREE.Color("#8b95bd"),
};

const reduceMotion =
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** A soft round glow, drawn once on a canvas and shared by every halo and spark. */
function useGlowTexture() {
  return useMemo(() => {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.18, "rgba(255,255,255,0.55)");
    gradient.addColorStop(0.45, "rgba(255,255,255,0.12)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, []);
}

function toneOf(service: Service, system: SystemView | null, focus: Focus | null): Tone {
  if (focus?.service === service) return focus.tone;
  const latest = system?.services?.[service]?.latest;
  if (system?.online && latest && latest.up === null) return "flare";
  return "calm";
}

interface StarProps {
  service: Service;
  system: SystemView | null;
  tone: Tone;
  selected: boolean;
  glow: THREE.Texture;
  onSelect: (s: Service | null) => void;
  onHover: (s: Service | null) => void;
}

function Star({ service, system, tone, selected, glow, onSelect, onHover }: StarProps) {
  const core = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Sprite>(null);
  const ring = useRef<THREE.Mesh>(null);
  const color = useRef(COLORS.calm.clone());
  const latest = system?.services?.[service]?.latest;
  const down = Boolean(system?.online && latest && latest.up === null);
  const rate = latest?.request_rate ?? 1;
  const tilt = useMemo(() => [Math.random() * 0.8 + 0.6, Math.random() * Math.PI, 0] as const, []);

  useFrame((state, delta) => {
    const target = down ? COLORS.ember : COLORS[tone];
    color.current.lerp(target, 1 - Math.exp(-delta * 3));
    const t = state.clock.elapsedTime;
    // A heartbeat: quicker when the service is busier, a slow uneven flicker when it is down.
    const beat = down
      ? 0.35 + 0.25 * Math.max(0, Math.sin(t * 7.3) * Math.sin(t * 2.1))
      : 0.85 + 0.15 * Math.pow(Math.max(0, Math.sin(t * (1.6 + rate * 0.15))), 8);
    const intensity = tone === "calm" ? 1.6 : 3.2;
    if (core.current) {
      (core.current.material as THREE.MeshBasicMaterial).color
        .copy(color.current)
        .multiplyScalar(down ? 0.6 : intensity);
      const s = (selected ? 1.25 : 1) * (tone === "calm" ? 1 : 1.18);
      core.current.scale.lerp(new THREE.Vector3(s, s, s), 1 - Math.exp(-delta * 6));
    }
    if (halo.current) {
      const material = halo.current.material as THREE.SpriteMaterial;
      material.color.copy(color.current);
      material.opacity = beat * (tone === "calm" ? 0.55 : 0.95);
      const size = (tone === "calm" ? 1.5 : 2.6) * (0.92 + beat * 0.12);
      halo.current.scale.set(size, size, 1);
    }
    if (ring.current && !reduceMotion) {
      ring.current.rotation.z += delta * (down ? 0 : 0.15 + rate * 0.06);
      (ring.current.material as THREE.MeshBasicMaterial).color.copy(color.current);
    }
  });

  return (
    <group position={POSITIONS[service]}>
      <mesh
        ref={core}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(selected ? null : service);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = "pointer";
          onHover(service);
        }}
        onPointerOut={() => {
          document.body.style.cursor = "";
          onHover(null);
        }}
      >
        <sphereGeometry args={[0.17, 32, 32]} />
        <meshBasicMaterial toneMapped={false} />
      </mesh>
      {/* A larger invisible target, so a small star is easy to click. */}
      <mesh
        visible={false}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(selected ? null : service);
        }}
      >
        <sphereGeometry args={[0.55, 8, 8]} />
      </mesh>
      <sprite ref={halo}>
        <spriteMaterial map={glow} blending={THREE.AdditiveBlending} depthWrite={false} transparent toneMapped={false} />
      </sprite>
      <mesh ref={ring} rotation={tilt as unknown as THREE.Euler}>
        <torusGeometry args={[0.42, 0.004, 8, 96]} />
        <meshBasicMaterial transparent opacity={0.55} toneMapped={false} />
      </mesh>
    </group>
  );
}

const SPARKS = 46;

interface ThreadProps {
  from: Service;
  to: Service;
  system: SystemView | null;
  glow: THREE.Texture;
  hot: boolean;
}

function Thread({ from, to, system, glow, hot }: ThreadProps) {
  const curve = useMemo(() => {
    const a = POSITIONS[from];
    const b = POSITIONS[to];
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += 0.55;
    mid.z += 0.35;
    return new THREE.QuadraticBezierCurve3(a, mid, b);
  }, [from, to]);
  const points = useMemo(() => curve.getPoints(64), [curve]);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
    return g;
  }, []);
  const state = useMemo(
    () => Array.from({ length: SPARKS }, (_, i) => ({ t: i / SPARKS + Math.random() * 0.02, failed: false })),
    [],
  );

  const edge = system?.edges?.find((e) => e.from === from && e.to === to);
  const callerRate = system?.services?.[from]?.latest.request_rate ?? 2;
  const calleeDown = Boolean(system?.online && system?.services?.[to]?.latest.up === null);
  const latency = edge?.latest.latency_p95 ?? 0.1;
  const failure = calleeDown ? 1 : (edge?.latest.failure_ratio ?? 0);

  useFrame((_, delta) => {
    // Sparks crawl when calls are slow: speed falls with the p95 of the calls on this thread.
    const speed = 0.22 * THREE.MathUtils.clamp(0.12 / Math.max(latency, 0.02), 0.12, 1.4) * (reduceMotion ? 0.4 : 1);
    const visible = Math.round(THREE.MathUtils.clamp(callerRate * 4, 6, SPARKS));
    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    const colors = geometry.getAttribute("color") as THREE.BufferAttribute;
    const p = new THREE.Vector3();
    for (let i = 0; i < SPARKS; i++) {
      const spark = state[i];
      spark.t += delta * speed * (0.85 + (i % 5) * 0.06);
      if (spark.t >= 1) {
        spark.t -= 1;
        spark.failed = Math.random() < failure;
      }
      // Calls to a dead service never arrive: they fade out before reaching it.
      const end = spark.failed && calleeDown ? 0.8 : 1;
      const t = Math.min(spark.t, end);
      curve.getPoint(t, p);
      positions.setXYZ(i, p.x, p.y, p.z);
      const c = i >= visible ? 0 : spark.failed ? 2.2 : 1.7;
      const base = spark.failed ? COLORS.flare : hot ? COLORS.sodium : COLORS.calm;
      const fade = Math.sin(Math.PI * Math.min(t / end, 1));
      colors.setXYZ(i, base.r * c * fade, base.g * c * fade, base.b * c * fade);
    }
    positions.needsUpdate = true;
    colors.needsUpdate = true;
  });

  return (
    <group>
      <Line points={points} color={hot ? "#ffa53d" : "#8b95bd"} lineWidth={1} transparent opacity={hot ? 0.45 : 0.18} />
      <points geometry={geometry}>
        <pointsMaterial
          size={0.17}
          map={glow}
          vertexColors
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
          sizeAttenuation
        />
      </points>
    </group>
  );
}

const AGENT_COLORS: Record<string, string> = {
  plan: "#e8edff",
  metrics: "#8fb7ff",
  logs: "#ffd38a",
  deploy: "#c9a6ff",
  solo: "#e8edff",
  diagnose: "#e8edff",
  recall: "#6fe3c8",
  propose: "#ffa53d",
};

function Comet({ name, index, around }: { name: string; index: number; around: Service }) {
  const body = useRef<THREE.Mesh>(null);
  const orbit = useMemo(
    () => ({
      radius: 0.75 + index * 0.17,
      speed: 1.1 - index * 0.12,
      tilt: new THREE.Euler(0.5 + index * 0.55, index * 1.3, 0),
      phase: index * 2.1,
    }),
    [index],
  );
  const centre = POSITIONS[around];
  const color = useMemo(() => new THREE.Color(AGENT_COLORS[name] ?? "#e8edff"), [name]);
  // The tail is drawn from where the comet was over the last moments of its orbit, worked out
  // from the orbit itself, so it is always a smooth arc whatever the frame rate.
  const tail = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TAIL * 3), 3));
    const colors = new Float32Array(TAIL * 3);
    for (let i = 0; i < TAIL; i++) {
      const fade = Math.pow(1 - i / (TAIL - 1), 2) * 2.4;
      colors.set([color.r * fade, color.g * fade, color.b * fade], i * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return g;
  }, [color]);
  const at = (t: number, out: THREE.Vector3) =>
    out.set(Math.cos(t) * orbit.radius, 0, Math.sin(t) * orbit.radius).applyEuler(orbit.tilt).add(centre);
  useFrame((state) => {
    if (!body.current) return;
    const t = state.clock.elapsedTime * orbit.speed * (reduceMotion ? 0.2 : 1) + orbit.phase;
    at(t, body.current.position);
    const positions = tail.getAttribute("position") as THREE.BufferAttribute;
    const p = new THREE.Vector3();
    for (let i = 0; i < TAIL; i++) {
      at(t - i * 0.028, p);
      positions.setXYZ(i, p.x, p.y, p.z);
    }
    positions.needsUpdate = true;
  });
  return (
    <group>
      <line>
        <primitive object={tail} attach="geometry" />
        <lineBasicMaterial vertexColors transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </line>
      <mesh ref={body}>
        <sphereGeometry args={[0.035, 12, 12]} />
        <meshBasicMaterial color={color.clone().multiplyScalar(3)} toneMapped={false} />
      </mesh>
    </group>
  );
}

const TAIL = 48;

type LabelRefs = React.MutableRefObject<Partial<Record<Service, HTMLDivElement | null>>>;

/** Keeps each star's DOM label just under the star on screen, every frame. */
function LabelTracker({ labels }: { labels: LabelRefs }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const point = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    for (const service of SERVICES) {
      const el = labels.current[service];
      if (!el) continue;
      point.copy(POSITIONS[service]);
      point.y -= 0.5;
      point.project(camera);
      const x = ((point.x + 1) / 2) * size.width;
      const y = ((1 - point.y) / 2) * size.height;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, 0)`;
      el.style.visibility = point.z > 1 ? "hidden" : "visible";
    }
  });
  return null;
}

/** Eases the camera towards the focused star, and back to the whole sky when nothing is. */
function CameraRig({ target, distance }: { target: Service | null; distance: number }) {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const camera = useThree((s) => s.camera);
  const goal = useRef(new THREE.Vector3());
  useFrame((_, delta) => {
    if (!controls) return;
    // With nothing focused, aim below and left of the middle, so the stars sit above the headline
    // and clear of the inbox in the top left corner.
    const wanted = target ? POSITIONS[target] : new THREE.Vector3(-0.5, -0.8, 0);
    goal.current.lerp(wanted, 1 - Math.exp(-delta * 1.8));
    controls.target.copy(goal.current);
    const offset = camera.position.clone().sub(controls.target);
    const want = target ? distance * 0.62 : distance;
    offset.setLength(THREE.MathUtils.lerp(offset.length(), want, 1 - Math.exp(-delta * 1.4)));
    camera.position.copy(controls.target).add(offset);
    controls.update();
  });
  return null;
}

export interface ConstellationProps {
  labels?: LabelRefs;
  system: SystemView | null;
  focus: Focus | null;
  agents: string[];
  selected: Service | null;
  cameraOn: Service | null;
  onSelect: (s: Service | null) => void;
  onHover?: (s: Service | null) => void;
}

function Scene({ system, focus, agents, selected, cameraOn, onSelect, onHover, labels }: ConstellationProps) {
  const glow = useGlowTexture();
  const { size } = useThree();
  const distance = size.width / size.height < 1 ? 15 : 9.5;
  const hotEdges = new Set(
    focus && focus.tone !== "aurora"
      ? EDGES.filter(([a, b]) => a === focus.service || b === focus.service).map(([a, b]) => `${a}-${b}`)
      : [],
  );
  return (
    <>
      <Stars radius={70} depth={50} count={3500} factor={3.2} saturation={0} fade speed={reduceMotion ? 0 : 0.5} />
      {EDGES.map(([from, to]) => (
        <Thread key={`${from}-${to}`} from={from} to={to} system={system} glow={glow} hot={hotEdges.has(`${from}-${to}`)} />
      ))}
      {SERVICES.map((service) => (
        <Star
          key={service}
          service={service}
          system={system}
          tone={toneOf(service, system, focus)}
          selected={selected === service}
          glow={glow}
          onSelect={onSelect}
          onHover={onHover ?? (() => {})}
        />
      ))}
      {focus &&
        agents.map((name, i) => <Comet key={name} name={name} index={i} around={focus.service} />)}
      <OrbitControls
        makeDefault
        enablePan={false}
        enableZoom={false}
        enableDamping
        dampingFactor={0.06}
        rotateSpeed={0.45}
        autoRotate={!reduceMotion}
        autoRotateSpeed={0.18}
        minPolarAngle={Math.PI * 0.3}
        maxPolarAngle={Math.PI * 0.62}
      />
      <CameraRig target={cameraOn} distance={distance} />
      {labels && <LabelTracker labels={labels} />}
      <EffectComposer multisampling={0}>
        <Bloom intensity={1.15} luminanceThreshold={0.18} luminanceSmoothing={0.3} mipmapBlur radius={0.72} />
        <Vignette eskil={false} offset={0.22} darkness={0.78} />
      </EffectComposer>
    </>
  );
}

function Labels({ system, focus, selected, labels }: ConstellationProps & { labels: LabelRefs }) {
  return (
    <div className="star-labels">
      {SERVICES.map((service) => {
        const latest = system?.services?.[service]?.latest;
        const down = Boolean(system?.online && latest && latest.up === null);
        const tone = down ? "flare" : toneOf(service, system, focus);
        const p95 = latest?.latency_p95 ?? null;
        return (
          <div key={service} className="star-label" ref={(el) => void (labels.current[service] = el)}>
            <div className={`star-tag tone-${tone}${selected === service ? " is-selected" : ""}`}>
              <span className="star-name">{serviceName[service]}</span>
              <span className="star-metric num">
                {down ? "not responding" : p95 !== null ? formatValue("x.latency_p95", p95) : "…"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Constellation(props: ConstellationProps) {
  const labels: LabelRefs = useRef({});
  return (
    <div className="constellation" aria-hidden="true">
      <Canvas
        dpr={[1, 1.75]}
        camera={{ position: [0, 0.9, 9.5], fov: 40 }}
        gl={{ antialias: false, alpha: true, powerPreference: "high-performance" }}
        onPointerMissed={() => props.onSelect(null)}
      >
        <Suspense fallback={null}>
          <Scene {...props} labels={labels} />
        </Suspense>
      </Canvas>
      <Labels {...props} labels={labels} />
    </div>
  );
}
