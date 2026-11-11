import { AnimatePresence, MotionConfig } from "motion/react";
import { lazy, Suspense, useMemo, useState } from "react";
import { Intro, introSeen } from "./components/Intro";
import { WatchBar } from "./components/WatchBar";
import { api, useMode, usePoll } from "./lib/api";
import { useRoute } from "./lib/route";
import { serviceOf, situation } from "./lib/state";
import type { Service } from "./lib/types";
import { History } from "./views/History";
import { Incident } from "./views/Incident";
import { Scores } from "./views/Scores";
import { Watch } from "./views/Watch";
import "./styles/app.css";

const Constellation = lazy(() =>
  import("./scene/Constellation").then((m) => ({ default: m.Constellation })),
);

export function App() {
  const route = useRoute();
  const mode = useMode();
  const system = usePoll(api.system, 5000, mode).data;
  const list = usePoll(api.investigations, 4000, mode).data;
  const live = usePoll(api.live, 1500, mode).data;
  const [selected, setSelected] = useState<Service | null>(null);
  const [hovered, setHovered] = useState<Service | null>(null);
  const [intro, setIntro] = useState(() => !introSeen());

  const now = situation(system, live, list);
  const open = route.page === "incident" ? route.id : null;
  const openInvestigation = usePoll(
    () => (open ? api.investigation(open) : Promise.resolve(null)),
    1500,
    `${open}-${mode}`,
  ).data;

  // On an incident page the camera flies to the service it is about.
  const cameraOn = useMemo(() => {
    if (route.page === "incident") return serviceOf(openInvestigation) ?? null;
    return selected;
  }, [route.page, openInvestigation, selected]);

  const focus =
    route.page === "incident" && openInvestigation && serviceOf(openInvestigation)
      ? {
          service: serviceOf(openInvestigation)!,
          tone:
            openInvestigation.action?.outcome === "executed"
              ? ("aurora" as const)
              : now.focus?.service === serviceOf(openInvestigation) && now.focus.tone === "flare"
                ? ("flare" as const)
                : ("sodium" as const),
        }
      : now.focus;
  const agents = now.agents;

  return (
    <MotionConfig reducedMotion="user">
      <div className={`sky sky-${focus?.tone ?? (now.kind === "offline" ? "offline" : "calm")}`} />
      <Suspense fallback={null}>
        <Constellation
          system={system}
          focus={focus}
          agents={agents}
          selected={route.page === "incident" ? hovered : selected}
          cameraOn={cameraOn}
          onSelect={setSelected}
          onHover={setHovered}
          fromAfar={intro}
        />
      </Suspense>
      <AnimatePresence>{intro && <Intro key="intro" onDone={() => setIntro(false)} />}</AnimatePresence>
      <WatchBar route={route} system={system} mode={mode} situation={now} />
      <AnimatePresence mode="wait">
        {!intro && route.page === "watch" && (
          <Watch
            key="watch"
            system={system}
            situation={now}
            list={list}
            mode={mode}
            selected={selected ?? hovered}
            onSelect={setSelected}
          />
        )}
        {route.page === "incident" && (
          <Incident key={`incident-${route.id}`} id={route.id} investigation={openInvestigation} mode={mode} system={system} onPoint={setHovered} />
        )}
        {route.page === "history" && <History key="history" list={list} />}
        {route.page === "scores" && <Scores key="scores" />}
      </AnimatePresence>
    </MotionConfig>
  );
}
