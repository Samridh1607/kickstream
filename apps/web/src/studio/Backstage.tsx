import {
  Badge, Button, makeStyles, mergeClasses, MessageBar, MessageBarBody, Popover, PopoverSurface, PopoverTrigger, Text, tokens,
} from "@fluentui/react-components";
import { MicOffRegular, MicRegular, PersonAddRegular, SettingsRegular, VideoRegular } from "@fluentui/react-icons";
import { useState } from "react";
import { DevicePickers } from "../calls/DevicePickers";
import { muteProblem, type useHostCall } from "../calls/useHostCall";
import { VideoBox } from "../calls/VideoBox";
import type { People } from "../contracts";
import { ROLE_NAMES, setStage } from "../people/api";
import { HOST, inviteLabel, SETUP } from "../people/PeoplePanel";

const useStyles = makeStyles({
  row: {
    display: "flex", flexWrap: "nowrap", gap: tokens.spacingHorizontalS, overflowX: "auto", maxHeight: "170px",
    paddingBottom: tokens.spacingVerticalXS,
  },
  tile: {
    flex: "0 0 200px", width: "200px", maxHeight: "164px", overflowY: "auto", boxSizing: "border-box",
    display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3,
  },
  inviteTile: {
    justifyContent: "center", alignItems: "center", backgroundColor: "transparent",
    border: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke1}`,
  },
  line: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXS },
  name: { flexGrow: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  video: { width: "120px" },
  devices: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, minWidth: "220px" },
  error: { color: tokens.colorPaletteRedForeground1 },
  warning: { color: tokens.colorPaletteDarkOrangeForeground1 },
});

interface BackstageProps {
  broadcastId: string;
  people: People | null;
  /** While the broadcast is live, everyone off stage is muted. */
  live: boolean;
  host: ReturnType<typeof useHostCall>;
  /** Sends one change and applies the people document it answers with. True when accepted; the caller shows refusals. */
  onRun(request: () => Promise<People>): Promise<boolean>;
  /** Opens the Guests tool. */
  onInvite(): void;
}

/** The people waiting off the stage and on it: the host's own camera first, then every guest, in one short row. */
export function Backstage({ broadcastId, people, live, host, onRun, onInvite }: BackstageProps) {
  const styles = useStyles();
  const [staging, setStaging] = useState(false);
  const { call, devices, problem, setProblem, join, toggleMute } = host;

  if (!people) return <section aria-label="Backstage"><Text>Loading people…</Text></section>;
  if (!people.service) {
    return (
      <section aria-label="Backstage">
        <MessageBar intent="info"><MessageBarBody>{SETUP}</MessageBarBody></MessageBar>
      </section>
    );
  }

  const stage = people.stage.map((person) => person.id);
  const hostOnStage = stage.includes(HOST);
  const mutedLive = live && !hostOnStage;
  // The new stage is built from the one shown, so a second change must wait for the first.
  const toggleStage = async (personId: string) => {
    setStaging(true);
    try {
      await onRun(() => setStage(broadcastId, stage.includes(personId) ? stage.filter((id) => id !== personId) : [...stage, personId]));
    } finally {
      setStaging(false);
    }
  };
  const hostStageButton = (
    <Button size="small" disabled={staging || (!hostOnStage && !people.host_acs_id)} onClick={() => void toggleStage(HOST)}>
      {hostOnStage ? "Remove me from stage" : "Add me to stage"}
    </Button>
  );
  const open = people.invites.filter((item) => !item.revoked);
  const inRoom = call?.state === "joined";

  return (
    <section aria-label="Backstage" className={styles.row}>
      <div className={styles.tile}>
        <div className={styles.line}>
          <Text size={200} weight="semibold" className={styles.name}>{`${people.host_name} (you)`}</Text>
          {hostOnStage && <Badge size="small" color="danger">On stage</Badge>}
        </div>
        {problem && <Text size={200} role="alert" className={styles.error}>{problem}</Text>}
        {devices.problem && <Text size={200} className={styles.warning}>{devices.problem}</Text>}
        {call === null ? (
          <div className={styles.line}>
            <Button size="small" icon={<VideoRegular />} onClick={() => void join()}>Join with camera</Button>
            {hostOnStage && hostStageButton}
          </div>
        ) : (
          <>
            <div className={styles.video}><VideoBox call={call} acsId={null} label="You" /></div>
            <div className={styles.line}>
              <Button size="small" icon={call.muted ? <MicOffRegular /> : <MicRegular />} disabled={call.muted && mutedLive}
                onClick={() => void toggleMute()}>
                {call.muted ? "Unmute" : "Mute"}
              </Button>
              <Popover positioning="above">
                <PopoverTrigger disableButtonEnhancement>
                  <Button size="small" appearance="subtle" icon={<SettingsRegular />}>Devices</Button>
                </PopoverTrigger>
                <PopoverSurface aria-label="Your devices">
                  <div className={styles.devices}><DevicePickers devices={devices} /></div>
                </PopoverSurface>
              </Popover>
              {hostStageButton}
            </div>
          </>
        )}
      </div>
      {open.map((item) => {
        const label = inviteLabel(item);
        const onStage = stage.includes(item.id);
        const seen = inRoom && item.acs_id !== null && call.participants.some((participant) => participant.acsId === item.acs_id);
        return (
          <div key={item.id} className={styles.tile}>
            <Text size={200} weight="semibold" className={styles.name}>{label}</Text>
            <div className={styles.line}>
              <Badge size="small" appearance="tint">{ROLE_NAMES[item.role]}</Badge>
              <Badge size="small" appearance="outline" color={item.present ? "success" : "informative"}>
                {item.present ? "Present" : item.acs_id ? "Away" : "Not joined yet"}
              </Badge>
              {onStage && <Badge size="small" color="danger">On stage</Badge>}
            </div>
            {seen && <div className={styles.video}><VideoBox call={call} acsId={item.acs_id!} label={label} /></div>}
            <div className={styles.line}>
              {item.role === "member" ? (
                <Text size={200}>Backstage only</Text>
              ) : (
                <Button size="small" disabled={staging || (!onStage && !item.acs_id)} onClick={() => void toggleStage(item.id)}>
                  {onStage ? `Remove ${label} from stage` : `Add ${label} to stage`}
                </Button>
              )}
              {inRoom && item.present && item.acs_id && (
                <Button size="small" icon={<MicOffRegular />} aria-label={`Mute ${label}`}
                  onClick={() => void call.muteParticipant(item.acs_id!).catch((caught: unknown) => setProblem(muteProblem(caught)))}>
                  Mute
                </Button>
              )}
            </div>
          </div>
        );
      })}
      <div className={mergeClasses(styles.tile, styles.inviteTile)}>
        <Button appearance="subtle" icon={<PersonAddRegular />} aria-label="Invite a guest" onClick={onInvite}>Invite</Button>
      </div>
    </section>
  );
}
