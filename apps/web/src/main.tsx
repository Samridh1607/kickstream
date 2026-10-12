import { FluentProvider } from "@fluentui/react-components";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useSystemTheme } from "./theme";

function Root() {
  return (
    <FluentProvider theme={useSystemTheme()} style={{ minHeight: "100%" }}>
      <App />
    </FluentProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
