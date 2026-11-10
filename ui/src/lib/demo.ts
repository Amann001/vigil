// Replaced in the demo phase by a replay of a real recorded incident.
export const demo = {
  get(path: string): unknown {
    throw new Error(`No API: ${path}`);
  },
  send(method: string, path: string, _body?: unknown): unknown {
    throw new Error(`No API: ${method} ${path}`);
  },
};
