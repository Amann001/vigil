import { useEffect, useState } from "react";

/** The page, from the part of the URL after #: "#/incident/live-1" → ["incident", "live-1"]. */
export type Route =
  | { page: "watch" }
  | { page: "incident"; id: string }
  | { page: "history" }
  | { page: "scores" };

function parse(hash: string): Route {
  const [page, ...rest] = hash.replace(/^#\/?/, "").split("/");
  if (page === "incident" && rest[0]) return { page: "incident", id: decodeURIComponent(rest.join("/")) };
  if (page === "history") return { page: "history" };
  if (page === "scores") return { page: "scores" };
  return { page: "watch" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function href(route: Route): string {
  if (route.page === "incident") return `#/incident/${encodeURIComponent(route.id)}`;
  if (route.page === "watch") return "#/";
  return `#/${route.page}`;
}

export function go(route: Route): void {
  window.location.hash = href(route);
}
