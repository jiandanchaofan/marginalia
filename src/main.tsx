import ReactDOM from "react-dom/client";
import App from "./App";
import { Card } from "./cards/Card";
import type { CardKind } from "./cards/state";
import { QuickWindow } from "./palette/QuickWindow";
import { limitNativeMenu } from "./nativeMenu";
import "./fonts.css";

// No StrictMode: document mounting is an imperative, one-shot side effect (DOM built by the format loaders).
limitNativeMenu();
const card = new URLSearchParams(location.search).get("card");
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
if (card === "notes" || card === "todo") {
  // a desktop card: its own small window, transparent around the rounded card
  document.documentElement.classList.add("card-mode");
  root.render(<Card kind={card as CardKind} />);
} else if (new URLSearchParams(location.search).has("quick")) {
  // the wake-up key's small window: only the command palette
  document.documentElement.classList.add("quick-mode");
  root.render(<QuickWindow />);
} else {
  root.render(<App />);
}
