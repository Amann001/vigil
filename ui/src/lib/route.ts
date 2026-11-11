import { useEffect, useState } from "react";
import { SERVICES, type Service } from "./types";

/**
 * The site's pages, each at its own address:
 *
 *   /                    home
 *   /war-room            the live watch
 *   /incidents           every incident;  /incidents/<id>  one of them
 *   /services/<name>     one service of the shop
 *   /how-it-works        the agent team
 *   /results             the evaluation
 *
 * Pages change without reloading (the 3D sky stays and the camera flies to the new page), so
 * links are plain <a href> elements and a single click handler turns them into navigation.
 */
export type Route =
  | { page: "home" }
  | { page: "watch" }
  | { page: "history" }
  | { page: "incident"; id: string }
  | { page: "service"; service: Service }
  | { page: "how" }
  | { page: "scores" }
  | { page: "lost" };

// Where the site lives: "" at the root, "/vigil-demo" on GitHub Pages.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const NAVIGATE = "vigil:navigate";

export function parse(pathname: string): Route {
  const path = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const [page = "", ...rest] = path.replace(/^\/+|\/+$/g, "").split("/");
  const id = rest.length ? decodeURIComponent(rest.join("/")) : "";
  switch (page) {
    case "":
      return { page: "home" };
    case "war-room":
      return { page: "watch" };
    case "incidents":
      return id ? { page: "incident", id } : { page: "history" };
    case "services":
      return SERVICES.includes(id as Service) ? { page: "service", service: id as Service } : { page: "lost" };
    case "how-it-works":
      return { page: "how" };
    case "results":
      return { page: "scores" };
    default:
      return { page: "lost" };
  }
}

export function href(route: Route): string {
  const path = (() => {
    switch (route.page) {
      case "home":
      case "lost":
        return "/";
      case "watch":
        return "/war-room";
      case "history":
        return "/incidents";
      case "incident":
        return `/incidents/${encodeURIComponent(route.id)}`;
      case "service":
        return `/services/${route.service}`;
      case "how":
        return "/how-it-works";
      case "scores":
        return "/results";
    }
  })();
  return `${BASE}${path}`;
}

export function navigate(to: string, { replace = false } = {}): void {
  if (to === window.location.pathname) return;
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.scrollTo(0, 0);
  window.dispatchEvent(new Event(NAVIGATE));
}

export function go(route: Route): void {
  navigate(href(route));
}

/** The war room's first addresses were "#/incident/<id>" and so on: send them to the new ones. */
function fromOldHash(hash: string): string | null {
  if (!hash.startsWith("#/")) return null;
  const [page, ...rest] = hash.slice(2).split("/");
  if (page === "incident" && rest.length) return href({ page: "incident", id: decodeURIComponent(rest.join("/")) });
  if (page === "history") return href({ page: "history" });
  if (page === "scores") return href({ page: "scores" });
  return href({ page: "watch" });
}

/** Turns clicks on the site's own links into page changes without a reload. */
function onClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element | null)?.closest?.("a");
  if (!link || link.target || link.hasAttribute("download")) return;
  const url = new URL(link.href, window.location.href);
  if (url.origin !== window.location.origin || !url.pathname.startsWith(BASE || "/")) return;
  if (/\.[a-z0-9]+$/i.test(url.pathname)) return; // a file, such as the film
  event.preventDefault();
  navigate(url.pathname);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.pathname));
  useEffect(() => {
    const old = fromOldHash(window.location.hash);
    if (old) navigate(old, { replace: true });
    const update = () => setRoute(parse(window.location.pathname));
    window.addEventListener("popstate", update);
    window.addEventListener(NAVIGATE, update);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(NAVIGATE, update);
      document.removeEventListener("click", onClick);
    };
  }, []);
  return route;
}
