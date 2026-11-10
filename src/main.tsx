import ReactDOM from "react-dom/client";
import App from "./App";
import "./fonts.css";

// No StrictMode: document mounting is an imperative, one-shot side effect (DOM built by the format loaders).
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
