import { AnimatePresence, MotionConfig } from "motion/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { Intro, introSeen } from "./components/Intro";
import { Cursor } from "./components/Motion";
import { ErrorBoundary, hasWebGL, loadOnce } from "./components/Safety";
import { WatchBar } from "./components/WatchBar";
import { api, useMode, usePoll } from "./lib/api";
import { useDecisionNotifications } from "./lib/notify";
import { useSoundCues, useStoryCues } from "./lib/sound";
import { go, href, type Route, useRoute } from "./lib/route";
import { serviceOf, situation } from "./lib/state";
import type { Service } from "./lib/types";
import { serviceName } from "./lib/words";
import type { View } from "./scene/Constellation";
import { Home } from "./views/Home";
import { Watch } from "./views/Watch";
import "./styles/app.css";

const Constellation = lazy(
  loadOnce(() => import("./scene/Constellation").then((m) => ({ default: m.Constellation }))),
);
// The home page and the war room come with the first download; the other pages load when first
// opened, so a first visit fetches less before anything is on screen.
const Audit = lazy(loadOnce(() => import("./views/Audit").then((m) => ({ default: m.Audit }))));
const History = lazy(loadOnce(() => import("./views/History").then((m) => ({ default: m.History }))));
const HowItWorks = lazy(loadOnce(() => import("./views/HowItWorks").then((m) => ({ default: m.HowItWorks }))));
const Incident = lazy(loadOnce(() => import("./views/Incident").then((m) => ({ default: m.Incident }))));
const Lost = lazy(loadOnce(() => import("./views/Lost").then((m) => ({ default: m.Lost }))));
const Policy = lazy(loadOnce(() => import("./views/Policy").then((m) => ({ default: m.Policy }))));
const Scores = lazy(loadOnce(() => import("./views/Scores").then((m) => ({ default: m.Scores }))));
const ServicePage = lazy(loadOnce(() => import("./views/ServicePage").then((m) => ({ default: m.ServicePage }))));
const Status = lazy(loadOnce(() => import("./views/Status").then((m) => ({ default: m.Status }))));
const Run = lazy(loadOnce(() => import("./views/Run").then((m) => ({ default: m.Run }))));
// Checked once: without 3D graphics the site runs on the plain night sky, with every page working.
const WEBGL = hasWebGL();

/*
  The home page's "one night" as the sky plays it: for each step of the story, how the Orders star
  looks and which agents circle it. The same tones and comets the war room uses for a real
  incident, so the replay on the home page is the product, not an illustration of it.
*/
const STORY: { tone: "calm" | "sodium" | "aurora"; agents: string[] }[] = [
  { tone: "calm", agents: [] },
  { tone: "sodium", agents: [] },
  { tone: "sodium", agents: ["logs", "metrics", "deploy"] },
  { tone: "sodium", agents: ["diagnose", "recall"] },
  { tone: "sodium", agents: ["propose"] },
  { tone: "aurora", agents: [] },
];
const STORY_SERVICE: Service = "orders";

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
    case "run":
      return "Run it | Vigil";
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
  // A star under the pointer, for the cursor (an incident page also points at stars, by hovered).
  const [starHover, setStarHover] = useState<Service | null>(null);
  const [intro, setIntro] = useState(() => !introSeen());
  const [pastHero, setPastHero] = useState(false);
  const [storyStep, setStoryStep] = useState(-1);

  const now = situation(system, live, list);
  const open = route.page === "incident" ? route.id : null;
  const openInvestigation = usePoll(
    () => (open ? api.investigation(open) : Promise.resolve(null)),
    1500,
    `${open}-${mode}`,
  ).data;

  useEffect(() => {
    const later = window.setTimeout(() => {
      for (const page of ["Audit", "History", "HowItWorks", "Incident", "Policy", "Run", "Scores", "ServicePage", "Status"])
        import(`./views/${page}.tsx`).catch(() => {});
    }, 4000);
    return () => window.clearTimeout(later);
  }, []);

  // The logo and a few accents take the colour of the shop's state (see brand.css).
  useEffect(() => {
    document.documentElement.dataset.state = now.kind;
  }, [now.kind]);

  useEffect(() => {
    document.title = titleOf(route);
    setHovered(null);
    setStarHover(null);
  }, [route]);

  const pageKey = route.page === "incident" ? `incident/${route.id}` : route.page === "service" ? `service/${route.service}` : route.page;
  useSoundCues(now.kind, pageKey);
  useStoryCues(route.page === "home" ? storyStep : -1);
  useDecisionNotifications(now.pending, mode === "live");

  const incidentService = route.page === "incident" ? serviceOf(openInvestigation) : null;
  const story = route.page === "home" && storyStep >= 0 ? STORY[storyStep] : null;
  const view: View =
    story
      ? { kind: "star", service: STORY_SERVICE, side: "right" }
      : route.page === "home"
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

  const focus = story
    ? { service: STORY_SERVICE, tone: story.tone }
    : route.page === "incident" && openInvestigation && incidentService
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
      <div className="grain" aria-hidden="true" />
      <Cursor star={starHover !== null} />
      <div className={`sky sky-${focus?.tone ?? (now.kind === "offline" ? "offline" : "calm")}`} />
      {WEBGL && (
      <ErrorBoundary>
      <Suspense fallback={null}>
        <Constellation
          system={system}
          focus={focus}
          agents={story ? story.agents : now.agents}
          selected={hovered}
          view={view}
          dim={["history", "how", "scores", "lost", "status", "audit", "policy", "run"].includes(route.page)}
          soft={route.page === "home" && pastHero && !story}
          warp={pageKey}
          onSelect={(service) => service && go({ page: "service", service })}
          onHover={(service) => {
            setHovered(service);
            setStarHover(service);
          }}
          linkTo={(service) => href({ page: "service", service })}
          fromAfar={intro}
        />
      </Suspense>
      </ErrorBoundary>
      )}
      <AnimatePresence>{intro && <Intro key="intro" onDone={() => setIntro(false)} />}</AnimatePresence>
      <WatchBar route={route} system={system} mode={mode} situation={now} />
      <CommandPalette list={list} mode={mode} />
      <Suspense fallback={null}>
      <AnimatePresence mode="wait">
        {!intro && route.page === "home" && <Home key="home" situation={now} system={system} list={list} onPastHero={setPastHero} onStory={setStoryStep} />}
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
        {route.page === "run" && <Run key="run" />}
        {route.page === "lost" && <Lost key="lost" />}
      </AnimatePresence>
      </Suspense>
    </MotionConfig>
  );
}
