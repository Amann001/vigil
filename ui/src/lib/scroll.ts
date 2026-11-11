/**
 * How far down the home page the visitor has scrolled, from 0 to 1. The 3D camera reads it every
 * frame to turn and pull back as the story goes on; it is a plain object rather than React
 * state so scrolling does not re-render the whole site sixty times a second.
 */
export const homeScroll = { progress: 0 };
