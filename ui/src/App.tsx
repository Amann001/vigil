import { AnimatePresence, MotionConfig } from "motion/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { Intro, introSeen } from "./components/Intro";
import { WatchBar } from "./components/WatchBar";
import { api, useMode, usePoll } from "./lib/api";
import { useDecisionNotifications } from "./lib/notify";
import { useSoundCues } from "./lib/sound";
import { go, href, type Route, useRoute } from "./lib/route";
import { serviceOf, situation } from "./lib/state";
import type { Service } from "./lib/types";
import { serviceName } from "./lib/words";
import type { View } from "./scene/Constellation";
import { Audit } from "./views/Audit";
import { History } from "./views/History";
import { Home } from "./views/Home";
import { HowItWorks } from "./views/HowItWorks";
import { Incident } from "./views/Incident";
import { Lost } from "./views/Lost";
import { Policy } from "./views/Policy";
import { Scores } from "./views/Scores";
import { ServicePage } from "./views/ServicePage";
import { Status } from "./views/Status";
import { Watch } from "./views/Watch";
import "./styles/app.css";

const Constellation = lazy(() =>
  import("./scene/Constellation").then((m) => ({ default: m.Constellation })),
);

function titleOf(route: Route): string {
  switch (route.page) {
    case "home":
      return "Vigil, the AI on-call engineer";
    case "watch":
      return "War room | Vigil";
    case "history":
      return "Incidents | Vigil";
    case "incident":
      return "Incident | Vigil";
    case "service":
      return `${serviceName[route.service]} | Vigil`;
    case "how":
      return "How it works | Vigil";
    case "scores":
      return "Results | Vigil";
    case "status":
      return "Status | Vigil";
    case "audit":
      return "Audit log | Vigil";
    case "policy":
      return "Policy | Vigil";
    case "lost":
      return "Lost in space | Vigil";
  }
}

export function App() {
  const route = useRoute();
  const mode = useMode();
  const system = usePoll(api.system, 5000, mode).data;
  const list = usePoll(api.investigations, 4000, mode).data;
  const live = usePoll(api.live, 1500, mode).data;
  const [hovered, setHovered] = useState<Service | null>(null);
  const [intro, setIntro] = useState(() => !introSeen());
  const [pastHero, setPastHero] = useState(false);

  const now = situation(system, live, list);
  const open = route.page === "incident" ? route.id : null;
  const openInvestigation = usePoll(
    () => (open ? api.investigation(open) : Promise.resolve(null)),
    1500,
    `${open}-${mode}`,
  ).data;

  useEffect(() => {
    document.title = titleOf(route);
    setHovered(null);
  }, [route]);

  const pageKey = route.page === "incident" ? `incident/${route.id}` : route.page === "service" ? `service/${route.service}` : route.page;
  useSoundCues(now.kind, pageKey);
  useDecisionNotifications(now.pending, mode === "live");

  const incidentService = route.page === "incident" ? serviceOf(openInvestigation) : null;
  const view: View =
    route.page === "home"
      ? { kind: "hero" }
      : route.page === "watch"
        ? { kind: "wide" }
        : route.page === "service"
          ? { kind: "star", service: route.service, side: "right" }
          : incidentService
            ? { kind: "star", service: incidentService }
            : route.page === "incident"
              ? { kind: "wide" }
              : { kind: "far" };

  const focus =
    route.page === "incident" && openInvestigation && incidentService
      ? {
          service: incidentService,
          tone:
            openInvestigation.action?.outcome === "executed"
              ? ("aurora" as const)
              : now.focus?.service === incidentService && now.focus.tone === "flare"
                ? ("flare" as const)
                : ("sodium" as const),
        }
      : now.focus;

  return (
    <MotionConfig reducedMotion="user">
      <div className={`sky sky-${focus?.tone ?? (now.kind === "offline" ? "offline" : "calm")}`} />
      <Suspense fallback={null}>
        <Constellation
          system={system}
          focus={focus}
          agents={now.agents}
          selected={hovered}
          view={view}
          dim={["history", "how", "scores", "lost", "status", "audit", "policy"].includes(route.page)}
          soft={route.page === "home" && pastHero}
          warp={pageKey}
          onSelect={(service) => service && go({ page: "service", service })}
          onHover={setHovered}
          linkTo={(service) => href({ page: "service", service })}
          fromAfar={intro}
        />
      </Suspense>
      <AnimatePresence>{intro && <Intro key="intro" onDone={() => setIntro(false)} />}</AnimatePresence>
      <WatchBar route={route} system={system} mode={mode} situation={now} />
      <CommandPalette list={list} mode={mode} />
      <AnimatePresence mode="wait">
        {!intro && route.page === "home" && <Home key="home" situation={now} system={system} list={list} onPastHero={setPastHero} />}
        {!intro && route.page === "watch" && (
          <Watch key="watch" system={system} situation={now} list={list} mode={mode} />
        )}
        {route.page === "service" && (
          <ServicePage
            key={`service-${route.service}`}
            service={route.service}
            system={system}
            list={list}
            situation={now}
            mode={mode}
          />
        )}
        {route.page === "incident" && (
          <Incident
            key={`incident-${route.id}`}
            id={route.id}
            investigation={openInvestigation}
            mode={mode}
            system={system}
            onPoint={setHovered}
          />
        )}
        {route.page === "history" && <History key="history" list={list} />}
        {route.page === "how" && <HowItWorks key="how" list={list} />}
        {route.page === "scores" && <Scores key="scores" />}
        {route.page === "status" && <Status key="status" system={system} situation={now} list={list} mode={mode} />}
        {route.page === "audit" && <Audit key="audit" mode={mode} />}
        {route.page === "policy" && <Policy key="policy" mode={mode} />}
        {route.page === "lost" && <Lost key="lost" />}
      </AnimatePresence>
    </MotionConfig>
  );
}
