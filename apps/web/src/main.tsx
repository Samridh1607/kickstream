import { FluentProvider } from "@fluentui/react-components";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { JoinPage } from "./audience/JoinPage";
import { HomePage } from "./home/HomePage";
import { MatchPage } from "./MatchPage";
import { isOutputView, ProgramPage } from "./studio/ProgramPage";
import { StudioPage } from "./studio/StudioPage";
import { useAppTheme } from "./theme";

/** The pages: the streamer's home and studio (with its clean output), the match data, and the fan join page. */
function Page() {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/join") return <JoinPage />;
  if (path === "/studio") return isOutputView(window.location.search) ? <ProgramPage /> : <StudioPage />;
  if (path === "/match") return <MatchPage />;
  return <HomePage />;
}

function Root() {
  return (
    <FluentProvider theme={useAppTheme()} style={{ minHeight: "100%" }}>
      <Page />
    </FluentProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
