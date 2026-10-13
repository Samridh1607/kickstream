import { FluentProvider } from "@fluentui/react-components";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { JoinPage } from "./audience/JoinPage";
import { HomePage } from "./home/HomePage";
import { MatchPage } from "./MatchPage";
import { ProgramPage } from "./studio/ProgramPage";
import { StudioPage } from "./studio/StudioPage";
import { useAppTheme } from "./theme";

/** The pages: the streamer's home and studio, the match data, the fan join page, and the clean program output. */
function Page() {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/join") return <JoinPage />;
  if (path === "/studio") return <StudioPage />;
  if (path === "/program") return <ProgramPage />;
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
