import { FluentProvider } from "@fluentui/react-components";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { JoinPage } from "./audience/JoinPage";
import { ProgramPage } from "./studio/ProgramPage";
import { StudioPage } from "./studio/StudioPage";
import { useSystemTheme } from "./theme";

/** The pages: the fan dashboard, the fan join page, the streamer's studio, and the clean program output. */
function Page() {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/join") return <JoinPage />;
  if (path === "/studio") return <StudioPage />;
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
