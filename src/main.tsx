import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { WorkspaceDirectoryControl } from "./WorkspaceDirectoryControl";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <WorkspaceDirectoryControl />
  </React.StrictMode>,
);
