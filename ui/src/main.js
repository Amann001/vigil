import { jsx as _jsx } from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/global.css";
// No StrictMode: its deliberate double mount leaves one of the 3D scene's HTML labels empty
// (each label renders into its own React root, which the second mount does not restore).
createRoot(document.getElementById("root")).render(_jsx(App, {}));
