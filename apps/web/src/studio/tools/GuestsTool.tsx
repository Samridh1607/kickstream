import { Badge, Button, Field, Input, makeStyles, MessageBar, MessageBarBody, Select, Text, tokens, Tooltip } from "@fluentui/react-components";
import { CopyRegular, DeleteRegular, PersonAddRegular } from "@fluentui/react-icons";
import { useState } from "react";
import type { People } from "../../contracts";
import { invite, inviteLink, revokeInvite, type Role, ROLE_NAMES } from "../../people/api";
import { inviteLabel, SETUP } from "../../people/PeoplePanel";

const MAX_INVITES = 12;

const useStyles = makeStyles({
  panel: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalM },
  list: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  item: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS, padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  row: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: tokens.spacingHorizontalXS },
  grow: { flexGrow: 1, minWidth: 0 },
});

interface GuestsToolProps {
  broadcastId: string;
  people: People | null;
  /** Sends one change and applies the people it answers with. True when it was accepted. */
  onRun(request: () => Promise<People>): Promise<boolean>;
}

/** Invite links by role, and who has used theirs. */
export function GuestsTool({ broadcastId, people, onRun }: GuestsToolProps) {
  const styles = useStyles();
  const [role, setRole] = useState<Role>("speaker");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  if (!people) return <Text>Loading people…</Text>;
  if (!people.service) return <MessageBar intent="info"><MessageBarBody>{SETUP}</MessageBarBody></MessageBar>;

  const stage = people.stage.map((person) => person.id);
  const open = people.invites.filter((item) => !item.revoked);
  const add = async () => {
    if (await onRun(() => invite(broadcastId, role, name))) setName("");
  };

  return (
    <div className={styles.panel}>
      {problem && <MessageBar intent="error"><MessageBarBody>{problem}</MessageBarBody></MessageBar>}
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
      <Button appearance="primary" icon={<PersonAddRegular />} disabled={open.length >= MAX_INVITES} onClick={() => void add()}>
        Invite
      </Button>
      <ul className={styles.list} aria-label="Guests">
        {open.map((item) => {
          const label = inviteLabel(item);
          const url = inviteLink(people, item.link);
          return (
            <li key={item.id} className={styles.item}>
              <div className={styles.row}>
                <Text weight="semibold" className={styles.grow}>{label}</Text>
                <Badge appearance="tint">{ROLE_NAMES[item.role]}</Badge>
                <Badge appearance="outline" color={item.present ? "success" : "informative"}>
                  {item.present ? "Present" : item.acs_id ? "Away" : "Not joined yet"}
                </Badge>
                {stage.includes(item.id) && <Badge color="danger">On stage</Badge>}
              </div>
              <div className={styles.row}>
                <Input readOnly size="small" className={styles.grow} aria-label={`Invite link for ${label}`} value={url} />
                <Tooltip content="Copy link" relationship="description">
                  <Button size="small" appearance="subtle" icon={<CopyRegular />} aria-label={`Copy link for ${label}`}
                    onClick={() => void navigator.clipboard?.writeText(url).catch(() => setProblem("The link could not be copied. Select it and copy it yourself."))} />
                </Tooltip>
                <Button size="small" appearance="subtle" icon={<DeleteRegular />} aria-label={`Revoke invite for ${label}`}
                  onClick={() => void onRun(() => revokeInvite(broadcastId, item.id))}>
                  Revoke
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
