import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AnimatePresence, MotionConfig } from "motion/react";
import { lazy, Suspense, useMemo, useState } from "react";
import { Intro, introSeen } from "./components/Intro";
import { WatchBar } from "./components/WatchBar";
import { api, useMode, usePoll } from "./lib/api";
import { useRoute } from "./lib/route";
import { serviceOf, situation } from "./lib/state";
import { History } from "./views/History";
import { Incident } from "./views/Incident";
import { Scores } from "./views/Scores";
import { Watch } from "./views/Watch";
import "./styles/app.css";
const Constellation = lazy(() => import("./scene/Constellation").then((m) => ({ default: m.Constellation })));
export function App() {
    const route = useRoute();
    const mode = useMode();
    const system = usePoll(api.system, 5000, mode).data;
    const list = usePoll(api.investigations, 4000, mode).data;
    const live = usePoll(api.live, 1500, mode).data;
    const [selected, setSelected] = useState(null);
    const [hovered, setHovered] = useState(null);
    const [intro, setIntro] = useState(() => !introSeen());
    const now = situation(system, live, list);
    const open = route.page === "incident" ? route.id : null;
    const openInvestigation = usePoll(() => (open ? api.investigation(open) : Promise.resolve(null)), 1500, `${open}-${mode}`).data;
    // On an incident page the camera flies to the service it is about.
    const cameraOn = useMemo(() => {
        if (route.page === "incident")
            return serviceOf(openInvestigation) ?? null;
        return selected;
    }, [route.page, openInvestigation, selected]);
    const focus = route.page === "incident" && openInvestigation && serviceOf(openInvestigation)
        ? {
            service: serviceOf(openInvestigation),
            tone: openInvestigation.action?.outcome === "executed"
                ? "aurora"
                : now.focus?.service === serviceOf(openInvestigation) && now.focus.tone === "flare"
                    ? "flare"
                    : "sodium",
        }
        : now.focus;
    const agents = now.agents;
    return (_jsxs(MotionConfig, { reducedMotion: "user", children: [_jsx("div", { className: `sky sky-${focus?.tone ?? (now.kind === "offline" ? "offline" : "calm")}` }), _jsx(Suspense, { fallback: null, children: _jsx(Constellation, { system: system, focus: focus, agents: agents, selected: route.page === "incident" ? hovered : selected, cameraOn: cameraOn, onSelect: setSelected, onHover: setHovered, fromAfar: intro }) }), _jsx(AnimatePresence, { children: intro && _jsx(Intro, { onDone: () => setIntro(false) }, "intro") }), _jsx(WatchBar, { route: route, system: system, mode: mode, situation: now }), _jsxs(AnimatePresence, { mode: "wait", children: [!intro && route.page === "watch" && (_jsx(Watch, { system: system, situation: now, list: list, mode: mode, selected: selected ?? hovered, onSelect: setSelected }, "watch")), route.page === "incident" && (_jsx(Incident, { id: route.id, investigation: openInvestigation, mode: mode, system: system, onPoint: setHovered }, `incident-${route.id}`)), route.page === "history" && _jsx(History, { list: list }, "history"), route.page === "scores" && _jsx(Scores, {}, "scores")] })] }));
}
