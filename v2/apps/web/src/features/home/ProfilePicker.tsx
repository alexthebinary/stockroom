import { Button, TextInput } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconBuildingWarehouse, IconCalculator, IconChevronLeft, IconPlus, IconSettings } from "@tabler/icons-react";
import { type FormEvent, useState } from "react";
import { Avatar, Chips } from "../../components/onboarding/Onboarding";
import { toastErr } from "../../components/ui";
import { get, type Job, post, type Profile } from "../../lib/api";
import { JOB_LABEL, useProfile } from "../../lib/profile";
import type { Setup } from "../../lib/types";

const JOB_HINT: Record<Job, string> = {
  CLERK: "You'll receive deliveries with the camera.",
  ACCOUNTING: "You'll review bills and freight, and pay them.",
  ADMIN: "You'll run orders, settings and the books.",
};
const ROLE_OPTIONS = (["CLERK", "ACCOUNTING", "ADMIN"] as Job[]).map((job) => ({
  value: job,
  label: JOB_LABEL[job],
  icon: { CLERK: <IconBuildingWarehouse size={20} />, ACCOUNTING: <IconCalculator size={20} />, ADMIN: <IconSettings size={20} /> }[job],
}));

/** "Who's working?": tap your name. No password (operator decision); it signs your work. */
export function ProfilePicker() {
  const { choose } = useProfile();
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => get<Profile[]>("/profiles") });
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => get<Setup>("/setup") });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [job, setJob] = useState<Job>("CLERK");
  const [busy, setBusy] = useState(false);
  const list = profiles.data ?? [];
  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await post<Profile>("/profiles", { name: name.trim(), job });
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
      choose(created);
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };

  if (adding || (profiles.isSuccess && list.length === 0)) {
    return (
      <div className="ob-picker">
        <form className="ob-picker-inner" style={{ maxWidth: 420, textAlign: "left", alignItems: "stretch" }} onSubmit={add}>
          {list.length ? (
            <button type="button" className="ob-back" onClick={() => setAdding(false)} aria-label="Back" style={{ marginBottom: 12 }}>
              <IconChevronLeft size={24} />
            </button>
          ) : null}
          <h1 className="ob-title">Add yourself</h1>
          <p className="ob-lede">Your name goes on everything you do. No password needed.</p>
          <div className="ob-fields">
            <TextInput label="Your name" size="lg" value={name} onChange={(e) => setName(e.currentTarget.value)} autoFocus data-autofocus />
            <div>
              <div className="ob-section-label">What do you do here?</div>
              <Chips label="What do you do here?" value={job} onChange={setJob} options={ROLE_OPTIONS} />
              <div className="ob-hint">{JOB_HINT[job]}</div>
            </div>
          </div>
          <Button type="submit" className="ob-cta" size="lg" fullWidth mt={32} disabled={!name.trim()} loading={busy}>
            Continue
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className="ob-picker">
      <div className="ob-picker-inner">
        <img className="ob-hero-mark" src="/icon.svg" alt="" style={{ width: 64, height: 64, borderRadius: 18 }} />
        <h1 className="ob-title">Who's working?</h1>
        <p className="ob-lede" style={{ marginInline: "auto" }}>
          {setup.data?.company.name ? `${setup.data.company.name} · ` : ""}Tap your name to start.
        </p>
        <div className="ob-people">
          {list.map((p) => (
            <button key={p.id} type="button" className="ob-person" onClick={() => choose(p)} aria-label={`${p.name}, ${JOB_LABEL[p.job]}`}>
              <Avatar name={p.name} size={84} />
              <span className="ob-person-name">{p.name}</span>
              <span className="ob-person-role">{JOB_LABEL[p.job]}</span>
            </button>
          ))}
          <button type="button" className="ob-person" onClick={() => setAdding(true)}>
            <span className="ob-person-new" style={{ width: 84, height: 84 }}>
              <IconPlus size={28} />
            </span>
            <span className="ob-person-name">Add yourself</span>
            <span className="ob-person-role">Not on the list?</span>
          </button>
        </div>
      </div>
    </div>
  );
}
