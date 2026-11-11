import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Billboard, Line, OrbitControls, Stars } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import { SERVICES } from "../lib/types";
import { formatValue, serviceName } from "../lib/words";
import "./constellation.css";
const POSITIONS = {
    storefront: new THREE.Vector3(-3.3, 0.15, 0.4),
    orders: new THREE.Vector3(-0.1, 0.55, -0.5),
    payments: new THREE.Vector3(3.1, 1.45, 0.2),
    inventory: new THREE.Vector3(2.2, -1.65, 0.9),
};
const EDGES = [
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
const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/** A soft round glow, drawn once on a canvas and shared by every halo and spark. */
function useGlowTexture() {
    return useMemo(() => {
        const size = 128;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d");
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
function toneOf(service, system, focus) {
    if (focus?.service === service)
        return focus.tone;
    const latest = system?.services?.[service]?.latest;
    if (system?.online && latest && latest.up === null)
        return "flare";
    return "calm";
}
const COLLAPSE = 0.45; // seconds the star takes to go out
const REIGNITE = 1.6; // seconds from going out to settled
const SHOCK = 1.8; // seconds the shockwave takes to spread and fade
/** The restart, as multipliers on the star's size and glow, `since` seconds after the fix. */
function restartPulse(since) {
    if (since < COLLAPSE) {
        const k = since / COLLAPSE;
        const out = 1 - k * k * 0.85; // accelerates as it goes out
        return { active: true, core: out, halo: out, shock: null };
    }
    const after = since - COLLAPSE;
    if (after < Math.max(REIGNITE, SHOCK)) {
        // Springs back past its size, then settles: a damped oscillation.
        const settle = after < REIGNITE ? 1 - Math.exp(-5 * after) * Math.cos(9 * after) * 0.85 : 1;
        return {
            active: after < REIGNITE,
            core: settle,
            halo: settle * (1 + 0.9 * Math.exp(-3 * after)),
            shock: after < SHOCK ? after / SHOCK : null,
        };
    }
    return { active: false, core: 1, halo: 1, shock: null };
}
function Star({ service, system, tone, selected, glow, onSelect, onHover }) {
    const core = useRef(null);
    const halo = useRef(null);
    const ring = useRef(null);
    const shock = useRef(null);
    const color = useRef(COLORS.calm.clone());
    // The moment a fix lands (trouble turning to aurora), the star restarts: it collapses,
    // re-ignites and sends out a shockwave.
    const previousTone = useRef(tone);
    const restartedAt = useRef(null);
    const latest = system?.services?.[service]?.latest;
    const down = Boolean(system?.online && latest && latest.up === null);
    const rate = latest?.request_rate ?? 1;
    const tilt = useMemo(() => [Math.random() * 0.8 + 0.6, Math.random() * Math.PI, 0], []);
    useFrame((state, delta) => {
        const t = state.clock.elapsedTime;
        if (previousTone.current !== tone) {
            const wasTrouble = previousTone.current === "sodium" || previousTone.current === "flare";
            if (tone === "aurora" && wasTrouble && !reduceMotion)
                restartedAt.current = t;
            previousTone.current = tone;
        }
        const since = restartedAt.current === null ? Infinity : t - restartedAt.current;
        const pulse = restartPulse(since);
        const target = down ? COLORS.ember : COLORS[tone];
        // While it collapses the star keeps its old colour; it comes back already healed.
        if (since > COLLAPSE)
            color.current.lerp(target, 1 - Math.exp(-delta * 3));
        // A heartbeat: quicker when the service is busier, a slow uneven flicker when it is down.
        const beat = down
            ? 0.35 + 0.25 * Math.max(0, Math.sin(t * 7.3) * Math.sin(t * 2.1))
            : 0.85 + 0.15 * Math.pow(Math.max(0, Math.sin(t * (1.6 + rate * 0.15))), 8);
        const intensity = tone === "calm" ? 1.6 : 3.2;
        if (core.current) {
            core.current.material.color
                .copy(color.current)
                .multiplyScalar(down ? 0.6 : intensity);
            const s = (selected ? 1.25 : 1) * (tone === "calm" ? 1 : 1.18);
            if (pulse.active)
                core.current.scale.setScalar(s * pulse.core);
            else
                core.current.scale.lerp(new THREE.Vector3(s, s, s), 1 - Math.exp(-delta * 6));
        }
        if (halo.current) {
            const material = halo.current.material;
            material.color.copy(color.current);
            material.opacity = Math.min(1, beat * (tone === "calm" ? 0.55 : 0.95) * pulse.halo);
            const size = (tone === "calm" ? 1.5 : 2.6) * (0.92 + beat * 0.12) * pulse.halo;
            halo.current.scale.set(size, size, 1);
        }
        if (shock.current) {
            shock.current.visible = pulse.shock !== null;
            if (pulse.shock !== null) {
                shock.current.scale.setScalar(0.3 + pulse.shock * 3.2);
                const material = shock.current.material;
                material.opacity = Math.pow(1 - pulse.shock, 1.6);
                material.color.copy(COLORS.aurora).multiplyScalar(1.4);
            }
        }
        if (ring.current && !reduceMotion) {
            ring.current.rotation.z += delta * (down ? 0 : 0.15 + rate * 0.06);
            ring.current.material.color.copy(color.current);
        }
    });
    return (_jsxs("group", { position: POSITIONS[service], children: [_jsxs("mesh", { ref: core, onClick: (e) => {
                    e.stopPropagation();
                    onSelect(selected ? null : service);
                }, onPointerOver: (e) => {
                    e.stopPropagation();
                    document.body.style.cursor = "pointer";
                    onHover(service);
                }, onPointerOut: () => {
                    document.body.style.cursor = "";
                    onHover(null);
                }, children: [_jsx("sphereGeometry", { args: [0.17, 32, 32] }), _jsx("meshBasicMaterial", { toneMapped: false })] }), _jsx("mesh", { visible: false, onClick: (e) => {
                    e.stopPropagation();
                    onSelect(selected ? null : service);
                }, children: _jsx("sphereGeometry", { args: [0.55, 8, 8] }) }), _jsx("sprite", { ref: halo, children: _jsx("spriteMaterial", { map: glow, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }) }), _jsx(Billboard, { children: _jsxs("mesh", { ref: shock, visible: false, children: [_jsx("ringGeometry", { args: [0.975, 1, 128] }), _jsx("meshBasicMaterial", { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })] }) }), _jsxs("mesh", { ref: ring, rotation: tilt, children: [_jsx("torusGeometry", { args: [0.42, 0.004, 8, 96] }), _jsx("meshBasicMaterial", { transparent: true, opacity: 0.55, toneMapped: false })] })] }));
}
const SPARKS = 46;
function Thread({ from, to, system, glow, hot }) {
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
    const state = useMemo(() => Array.from({ length: SPARKS }, (_, i) => ({ t: i / SPARKS + Math.random() * 0.02, failed: false })), []);
    const edge = system?.edges?.find((e) => e.from === from && e.to === to);
    const callerRate = system?.services?.[from]?.latest.request_rate ?? 2;
    const calleeDown = Boolean(system?.online && system?.services?.[to]?.latest.up === null);
    const latency = edge?.latest.latency_p95 ?? 0.1;
    const failure = calleeDown ? 1 : (edge?.latest.failure_ratio ?? 0);
    useFrame((_, delta) => {
        // Sparks crawl when calls are slow: speed falls with the p95 of the calls on this thread.
        const speed = 0.22 * THREE.MathUtils.clamp(0.12 / Math.max(latency, 0.02), 0.12, 1.4) * (reduceMotion ? 0.4 : 1);
        const visible = Math.round(THREE.MathUtils.clamp(callerRate * 4, 6, SPARKS));
        const positions = geometry.getAttribute("position");
        const colors = geometry.getAttribute("color");
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
    return (_jsxs("group", { children: [_jsx(Line, { points: points, color: hot ? "#ffa53d" : "#8b95bd", lineWidth: 1, transparent: true, opacity: hot ? 0.45 : 0.18 }), _jsx("points", { geometry: geometry, children: _jsx("pointsMaterial", { size: 0.17, map: glow, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, sizeAttenuation: true }) })] }));
}
const AGENT_COLORS = {
    plan: "#e8edff",
    metrics: "#8fb7ff",
    logs: "#ffd38a",
    deploy: "#c9a6ff",
    solo: "#e8edff",
    diagnose: "#e8edff",
    recall: "#6fe3c8",
    propose: "#ffa53d",
};
function Comet({ name, index, around }) {
    const body = useRef(null);
    const orbit = useMemo(() => ({
        radius: 0.75 + index * 0.17,
        speed: 1.1 - index * 0.12,
        tilt: new THREE.Euler(0.5 + index * 0.55, index * 1.3, 0),
        phase: index * 2.1,
    }), [index]);
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
    const at = (t, out) => out.set(Math.cos(t) * orbit.radius, 0, Math.sin(t) * orbit.radius).applyEuler(orbit.tilt).add(centre);
    useFrame((state) => {
        if (!body.current)
            return;
        const t = state.clock.elapsedTime * orbit.speed * (reduceMotion ? 0.2 : 1) + orbit.phase;
        at(t, body.current.position);
        const positions = tail.getAttribute("position");
        const p = new THREE.Vector3();
        for (let i = 0; i < TAIL; i++) {
            at(t - i * 0.028, p);
            positions.setXYZ(i, p.x, p.y, p.z);
        }
        positions.needsUpdate = true;
    });
    return (_jsxs("group", { children: [_jsxs("line", { children: [_jsx("primitive", { object: tail, attach: "geometry" }), _jsx("lineBasicMaterial", { vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })] }), _jsxs("mesh", { ref: body, children: [_jsx("sphereGeometry", { args: [0.035, 12, 12] }), _jsx("meshBasicMaterial", { color: color.clone().multiplyScalar(3), toneMapped: false })] })] }));
}
const TAIL = 48;
/** Keeps each star's DOM label just under the star on screen, every frame. */
function LabelTracker({ labels }) {
    const camera = useThree((s) => s.camera);
    const size = useThree((s) => s.size);
    const point = useMemo(() => new THREE.Vector3(), []);
    useFrame(() => {
        for (const service of SERVICES) {
            const el = labels.current[service];
            if (!el)
                continue;
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
function CameraRig({ target, distance, slow }) {
    const controls = useThree((s) => s.controls);
    const camera = useThree((s) => s.camera);
    const goal = useRef(new THREE.Vector3());
    useFrame((_, delta) => {
        if (!controls)
            return;
        // With nothing focused, aim below and left of the middle, so the stars sit above the headline
        // and clear of the inbox in the top left corner.
        const wanted = target ? POSITIONS[target] : new THREE.Vector3(-0.5, -0.8, 0);
        goal.current.lerp(wanted, 1 - Math.exp(-delta * 1.8));
        controls.target.copy(goal.current);
        const offset = camera.position.clone().sub(controls.target);
        const want = target ? distance * 0.62 : distance;
        // The opening flight from deep space is slower, so it reads as a journey.
        const rate = slow ? 0.55 : 1.4;
        offset.setLength(THREE.MathUtils.lerp(offset.length(), want, 1 - Math.exp(-delta * rate)));
        camera.position.copy(controls.target).add(offset);
        controls.update();
    });
    return null;
}
function Scene({ system, focus, agents, selected, cameraOn, onSelect, onHover, labels, fromAfar }) {
    const glow = useGlowTexture();
    const { size } = useThree();
    // Far enough that the whole constellation (about 9 units wide) fits the screen's width: a
    // phone held upright needs the camera much further back than a laptop.
    const aspect = size.width / size.height;
    const distance = Math.max(9.5, 4.8 / (Math.tan(THREE.MathUtils.degToRad(20)) * aspect));
    const hotEdges = new Set(focus && focus.tone !== "aurora"
        ? EDGES.filter(([a, b]) => a === focus.service || b === focus.service).map(([a, b]) => `${a}-${b}`)
        : []);
    return (_jsxs(_Fragment, { children: [_jsx(Stars, { radius: 70, depth: 50, count: 3500, factor: 3.2, saturation: 0, fade: true, speed: reduceMotion ? 0 : 0.5 }), EDGES.map(([from, to]) => (_jsx(Thread, { from: from, to: to, system: system, glow: glow, hot: hotEdges.has(`${from}-${to}`) }, `${from}-${to}`))), SERVICES.map((service) => (_jsx(Star, { service: service, system: system, tone: toneOf(service, system, focus), selected: selected === service, glow: glow, onSelect: onSelect, onHover: onHover ?? (() => { }) }, service))), focus &&
                agents.map((name, i) => _jsx(Comet, { name: name, index: i, around: focus.service }, name)), _jsx(OrbitControls, { makeDefault: true, enablePan: false, enableZoom: false, enableDamping: true, dampingFactor: 0.06, rotateSpeed: 0.45, autoRotate: !reduceMotion, autoRotateSpeed: 0.18, minPolarAngle: Math.PI * 0.3, maxPolarAngle: Math.PI * 0.62 }), _jsx(CameraRig, { target: cameraOn, distance: distance, slow: Boolean(fromAfar) }), labels && _jsx(LabelTracker, { labels: labels }), _jsxs(EffectComposer, { multisampling: 0, children: [_jsx(Bloom, { intensity: 1.15, luminanceThreshold: 0.18, luminanceSmoothing: 0.3, mipmapBlur: true, radius: 0.72 }), _jsx(Vignette, { eskil: false, offset: 0.22, darkness: 0.78 })] })] }));
}
function Labels({ system, focus, selected, labels, fromAfar }) {
    return (_jsx("div", { className: `star-labels${fromAfar ? " is-hidden" : ""}`, children: SERVICES.map((service) => {
            const latest = system?.services?.[service]?.latest;
            const down = Boolean(system?.online && latest && latest.up === null);
            const tone = down ? "flare" : toneOf(service, system, focus);
            const p95 = latest?.latency_p95 ?? null;
            return (_jsx("div", { className: "star-label", ref: (el) => void (labels.current[service] = el), children: _jsxs("div", { className: `star-tag tone-${tone}${selected === service ? " is-selected" : ""}`, children: [_jsx("span", { className: "star-name", children: serviceName[service] }), _jsx("span", { className: "star-metric num", children: down ? "not responding" : p95 !== null ? formatValue("x.latency_p95", p95) : "…" })] }) }, service));
        }) }));
}
export function Constellation(props) {
    const labels = useRef({});
    return (_jsxs("div", { className: "constellation", "aria-hidden": "true", children: [_jsx(Canvas, { dpr: [1, 1.75], camera: { position: props.fromAfar ? [0, 9, 48] : [0, 0.9, 9.5], fov: 40 }, gl: { antialias: false, alpha: true, powerPreference: "high-performance" }, onPointerMissed: () => props.onSelect(null), children: _jsx(Suspense, { fallback: null, children: _jsx(Scene, { ...props, labels: labels }) }) }), _jsx(Labels, { ...props, labels: labels })] }));
}
