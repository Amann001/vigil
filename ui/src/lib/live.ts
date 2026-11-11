/**
 * The address of the live system, when this build is the public replay and one is running
 * (set as VITE_LIVE_URL on the static host). Without it, the replay links nowhere.
 */
export const LIVE_URL: string | null = import.meta.env.VITE_LIVE_URL || null;
