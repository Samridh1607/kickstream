import { Badge, Button, Field, Input, makeStyles, MessageBar, MessageBarBody, Select, Text, tokens, Tooltip } from "@fluentui/react-components";
import { CopyRegular, DeleteRegular, MicOffRegular, MicRegular, PersonAddRegular, VideoRegular } from "@fluentui/react-icons";
import { useEffect, useRef, useState } from "react";
import { DevicePickers } from "../calls/DevicePickers";
import { openRoomCall } from "../calls/open";
import type { RoomCall } from "../calls/RoomCall";
import { useCallUpdates } from "../calls/useCallUpdates";
import { useDevices } from "../calls/useDevices";
import { VideoBox } from "../calls/VideoBox";
import type { CallSeat, Invite, People } from "../contracts";
import { hostSeat, invite, inviteLink, revokeInvite, type Role, ROLE_NAMES, setStage } from "./api";

export const HOST = "host";
export const SETUP = "Guests need Azure Communication Services. Put KICKSTREAM_ACS_CONNECTION_STRING in the .env file at the top of the project, then restart the pipeline.";
const MAX_INVITES = 12;

export const inviteLabel = (item: Invite) => item.joined_name ?? item.name ?? ROLE_NAMES[item.role];

const muteProblem = (caught: unknown) => (caught instanceof Error ? caught.message : "The microphone could not be changed.");

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  item: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXS },
  grow: { flexGrow: 1, minWidth: 0 },
  tiles: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: tokens.spacingHorizontalS },
});

interface PeoplePanelProps {
  broadcastId: string;
  people: People | null;
  /** While the broadcast is live, everyone off stage is muted. */
  live: boolean;
  onPeople(doc: People): void;
  newCall?: (service: CallSeat["service"]) => RoomCall;
}

/** Who takes part in the broadcast: invite links by role, who is here, the stage, and the host's own camera. */
export function PeoplePanel({ broadcastId, people, live, onPeople, newCall = openRoomCall }: PeoplePanelProps) {
  const styles = useStyles();
  const [role, setRole] = useState<Role>("speaker");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);
  const [call, setCall] = useState<RoomCall | null>(null);
  useCallUpdates(call);
  const currentCall = useRef(call);
  useEffect(() => {
    currentCall.current = call;
    return () => {
      currentCall.current = null;
      // The call is being given up; there is nowhere to show a failed leave.
      call?.leave().catch(() => undefined);
    };
  }, [call]);
  const devices = useDevices(call);
  const stage = people?.stage.map((person) => person.id) ?? [];
  const hostOnStage = stage.includes(HOST);
  const mutedLive = live && !hostOnStage;
  const mutedLiveNow = useRef(mutedLive);
  const joined = call?.state === "joined";
  useEffect(() => {
    mutedLiveNow.current = mutedLive;
    if (!call || !mutedLive) return;
    call.setMuted(true).catch((caught: unknown) => {
      if (currentCall.current === call) setProblem(muteProblem(caught));
    });
  }, [call, mutedLive, joined]);

  if (!people) return <Text>Loading people…</Text>;
  const service = people.service;
  if (!service) return <MessageBar intent="info"><MessageBarBody>{SETUP}</MessageBarBody></MessageBar>;

  const run = async (request: () => Promise<People>) => {
    try {
      onPeople(await request());
      setProblem(null);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The change was not made.");
    }
  };
  // The new stage is built from the one shown, so a second change must wait for the first.
  const toggleStage = async (personId: string) => {
    setStaging(true);
    try {
      await run(() => setStage(broadcastId, stage.includes(personId) ? stage.filter((id) => id !== personId) : [...stage, personId]));
    } finally {
      setStaging(false);
    }
  };
  const hostStageButton = (
    <Button size="small" disabled={staging || (!hostOnStage && !people.host_acs_id)} onClick={() => void toggleStage(HOST)}>
      {hostOnStage ? "Remove me from stage" : "Add me to stage"}
    </Button>
  );
  const joinHost = async () => {
    const made = newCall(service);
    setCall(made);
    try {
      const seat = await hostSeat(broadcastId, people.host_name);
      await made.setMuted(mutedLiveNow.current);
      await made.join({ roomId: seat.room_id, token: seat.token, name: people.host_name, refresh: async () => (await hostSeat(broadcastId, people.host_name)).token });
      setProblem(null);
    } catch (caught) {
      // Leaving a call rejects its join that is still starting; that is not the host's problem.
      if (currentCall.current !== made) return;
      setCall(null);
      setProblem(caught instanceof Error ? caught.message : "Your camera could not join.");
    }
  };
  const open = people.invites.filter((item) => !item.revoked);
  const inRoom = call?.state === "joined";

  return (
    <div className={styles.panel}>
      {problem && <MessageBar intent="error"><MessageBarBody>{problem}</MessageBarBody></MessageBar>}
      {devices.problem && <MessageBar intent="warning"><MessageBarBody>{devices.problem}</MessageBarBody></MessageBar>}
      <div className={styles.item}>
        <div className={styles.row}>
          <Text weight="semibold" className={styles.grow}>{`${people.host_name} (you)`}</Text>
          {hostOnStage && <Badge color="danger">On stage</Badge>}
        </div>
        {call === null ? (
          <div className={styles.row}>
            <Button icon={<VideoRegular />} onClick={() => void joinHost()}>Join with camera</Button>
            {hostOnStage && hostStageButton}
          </div>
        ) : (
          <>
            <VideoBox call={call} acsId={null} label="You" />
            <DevicePickers devices={devices} />
            <div className={styles.row}>
              <Button size="small" icon={call.muted ? <MicOffRegular /> : <MicRegular />} disabled={call.muted && mutedLive}
                onClick={() => void call.setMuted(!call.muted).catch((caught: unknown) => setProblem(muteProblem(caught)))}>
                {call.muted ? "Unmute" : "Mute"}
              </Button>
              {hostStageButton}
            </div>
          </>
        )}
      </div>
      <ul className={styles.list} aria-label="Guests">
        {open.map((item) => {
          const label = inviteLabel(item);
          const onStage = stage.includes(item.id);
          const url = inviteLink(people, item.link);
          return (
            <li key={item.id} className={styles.item}>
              <div className={styles.row}>
                <Text weight="semibold" className={styles.grow}>{label}</Text>
                <Badge appearance="tint">{ROLE_NAMES[item.role]}</Badge>
                <Badge appearance="outline" color={item.present ? "success" : "informative"}>
                  {item.present ? "Present" : item.acs_id ? "Away" : "Not joined yet"}
                </Badge>
                {onStage && <Badge color="danger">On stage</Badge>}
              </div>
              <div className={styles.row}>
                <Input readOnly size="small" className={styles.grow} aria-label={`Invite link for ${label}`} value={url} />
                <Tooltip content="Copy link" relationship="description">
                  <Button size="small" appearance="subtle" icon={<CopyRegular />} aria-label={`Copy link for ${label}`}
                    onClick={() => void navigator.clipboard?.writeText(url).catch(() => setProblem("The link could not be copied. Select it and copy it yourself."))} />
                </Tooltip>
              </div>
              <div className={styles.row}>
                {item.role !== "member" && (
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
                <Button size="small" appearance="subtle" icon={<DeleteRegular />} aria-label={`Revoke invite for ${label}`}
                  onClick={() => void run(() => revokeInvite(broadcastId, item.id))}>
                  Revoke
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {inRoom && call.participants.length > 0 && (
        <div className={styles.tiles} aria-label="In the room">
          {call.participants.map((participant) => (
            <VideoBox key={participant.acsId} call={call} acsId={participant.acsId} label={participant.name} />
          ))}
        </div>
      )}
      <div className={styles.row}>
        <Field label="Role">
          <Select value={role} onChange={(_, data) => setRole(data.value as Role)}>
            <option value="speaker">Speaker</option>
            <option value="cohost">Co-host</option>
            <option value="member">Member</option>
          </Select>
        </Field>
        <Field label="Name (optional)" className={styles.grow}>
          <Input value={name} maxLength={40} onChange={(_, data) => setName(data.value)} />
        </Field>
      </div>
      <Button appearance="primary" icon={<PersonAddRegular />} disabled={open.length >= MAX_INVITES}
        onClick={() => void run(async () => {
          const doc = await invite(broadcastId, role, name);
          setName("");
          return doc;
        })}>
        Invite
      </Button>
    </div>
  );
}
