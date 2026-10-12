import { FluentProvider } from "@fluentui/react-components";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ProgramPage } from "./studio/ProgramPage";
import { useSystemTheme } from "./theme";

/** The three pages. `/studio` is added in the next task. */
function Page() {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/program") return <ProgramPage />;
  return <App />;
}

function Root() {
  return (
    <FluentProvider theme={useSystemTheme()} style={{ minHeight: "100%" }}>
      <Page />
    </FluentProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
