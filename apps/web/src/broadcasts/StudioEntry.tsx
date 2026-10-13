import { Button, makeStyles, Spinner, Text, tokens } from "@fluentui/react-components";
import { AddRegular, ChevronRightRegular, VideoClipMultipleRegular } from "@fluentui/react-icons";
import { useEffect } from "react";
import type { Broadcasts } from "../contracts";
import { AppNav } from "../shell/AppNav";
import { useLiveDocument } from "../stream/useLiveDocument";
import { BROADCASTS_STREAM, studioPath } from "./api";
import { CreateBroadcastDialog } from "./CreateBroadcastDialog";
import { plural, when } from "./format";
import { studioTarget } from "./StudioBroadcast";

const useStyles = makeStyles({
  page: { minHeight: "100vh", display: "flex", flexDirection: "column", backgroundColor: tokens.colorNeutralBackground2 },
  main: { display: "flex", justifyContent: "center", padding: tokens.spacingHorizontalXXL },
  card: {
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL, width: "100%", maxWidth: "640px", padding: tokens.spacingHorizontalXXL,
    borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow8,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`,
  },
  icon: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: "48px", height: "48px", borderRadius: "14px", fontSize: "26px",
    color: tokens.colorBrandForeground1, backgroundColor: tokens.colorBrandBackground2,
  },
  muted: { color: tokens.colorNeutralForeground3 },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  item: {
    display: "flex", alignItems: "center", gap: tokens.spacingHorizontalM, padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusLarge,
    color: "inherit", textDecorationLine: "none", backgroundColor: tokens.colorNeutralBackground3,
    ":hover": { backgroundColor: tokens.colorNeutralBackground3Hover },
  },
  itemText: { display: "flex", flexDirection: "column", gap: "2px", flexGrow: 1, minWidth: 0 },
});

interface Props {
  eventSource?: new (url: string) => EventSource;
  retryMs?: number;
  /** Leaves for another page; replaced in tests. */
  navigate?: (path: string) => void;
}

const leave = (path: string) => window.location.replace(path);

/** `/studio`: the studio always works on a broadcast, so open the one on air or the current one, or ask for one. */
export function StudioEntry({ eventSource, retryMs, navigate = leave }: Props) {
  const styles = useStyles();
  const { doc, accept } = useLiveDocument<Broadcasts>(BROADCASTS_STREAM, eventSource, retryMs);
  const target = doc ? studioTarget(doc) : null;

  useEffect(() => {
    if (target) navigate(studioPath(target.id));
  }, [target, navigate]);

  const ready = doc?.broadcasts.filter((item) => item.state === "ready") ?? [];
  const opened = (answer: Broadcasts) => {
    accept(answer);
    if (answer.current_id) navigate(studioPath(answer.current_id));
  };

  return (
    <div className={styles.page}>
      <AppNav current="studio" />
      <main className={styles.main}>
        {doc === null || target ? (
          <Spinner label="Opening the studio…" />
        ) : (
          <section className={styles.card} aria-label="Choose a broadcast">
            <span className={styles.icon} aria-hidden><VideoClipMultipleRegular /></span>
            <Text as="h1" size={700} weight="bold">Choose a broadcast for the studio</Text>
            <Text className={styles.muted}>
              The studio works on one broadcast at a time. Its scenes, banners and output go out as that broadcast, which keeps the sessions, recording and stats.
            </Text>
            {ready.length > 0 && (
              <ul className={styles.list} aria-label="Broadcasts ready to go live">
                {ready.map((item) => (
                  <li key={item.id}>
                    <a href={studioPath(item.id)} className={styles.item} aria-label={`Open ${item.title} in the studio`}>
                      <span className={styles.itemText}>
                        <Text weight="semibold" truncate wrap={false}>{item.title}</Text>
                        <Text size={200} className={styles.muted}>
                          {`Created ${when(item.created_at)} · ${item.sessions.length > 0 ? plural(item.sessions.length, "session") : "not live yet"}`}
                        </Text>
                      </span>
                      <ChevronRightRegular />
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <CreateBroadcastDialog onCreated={opened}
              trigger={<Button appearance="primary" size="large" icon={<AddRegular />}>Create a broadcast</Button>} />
          </section>
        )}
      </main>
    </div>
  );
}
