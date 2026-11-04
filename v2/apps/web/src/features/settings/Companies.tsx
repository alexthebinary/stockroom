import { Alert, Badge, Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { toastErr } from "../../components/ui";
import { companyId, del, get, post, switchCompany } from "../../lib/api";

export type CompanyInfo = { id: string; name: string; createdAt: string; setupDone: boolean; test: boolean };
type CompanyList = { enabled: boolean; current: string; companies: CompanyInfo[] };

export const useCompanies = () => useQuery({ queryKey: ["companies", companyId], queryFn: () => get<CompanyList>("/companies"), staleTime: 60_000 });

/**
 * Test companies: a brand-new, empty set of books to try the product from the
 * first screen, without touching the main company. Notes left in any company
 * still go to the one Feedback list.
 */
export function CompaniesPanel() {
  const list = useCompanies();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  if (!list.data) return null;
  if (!list.data.enabled) return null;
  const { current, companies } = list.data;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const made = await post<CompanyInfo>("/companies", { name: name.trim() });
      switchCompany(made.id);
    } catch (error) {
      toastErr(error);
      setBusy(false);
    }
  };
  const remove = async (company: CompanyInfo) => {
    if (!window.confirm(`Delete the test company "${company.name}" and everything in it? This can't be undone.`)) return;
    try {
      await del(`/companies/${company.id}`);
      if (company.id === current) switchCompany(null);
      else list.refetch();
    } catch (error) {
      toastErr(error);
    }
  };

  return (
    <Stack gap="sm">
      <Text c="dimmed" size="sm">
        A test company starts completely empty and opens setup from the first screen. The main company is not touched. Feedback notes from any company go to the same Feedback list.
      </Text>
      {companies.map((c) => (
        <Group key={c.id} justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap">
            <Text fw={c.id === current ? 600 : undefined}>{c.name}</Text>
            {c.test ? <Badge size="sm" variant="light" color="orange">Test</Badge> : <Badge size="sm" variant="light">Main</Badge>}
            {c.test ? <Text size="xs" c="dimmed">{new Date(c.createdAt).toLocaleDateString()}</Text> : null}
            {c.id === current ? <Badge size="sm" variant="outline">You're here</Badge> : null}
          </Group>
          <Group gap={4} wrap="nowrap">
            {c.id !== current ? (
              <Button size="xs" variant="light" onClick={() => switchCompany(c.id)}>
                Switch
              </Button>
            ) : null}
            {c.test ? (
              <Button size="xs" variant="subtle" color="red" onClick={() => remove(c)}>
                Delete
              </Button>
            ) : null}
          </Group>
        </Group>
      ))}
      <form onSubmit={create}>
        <Group align="flex-end" wrap="nowrap">
          <TextInput label="New test company" placeholder="e.g. Acme Test" value={name} onChange={(e) => setName(e.currentTarget.value)} style={{ flex: 1 }} maxLength={120} />
          <Button type="submit" disabled={!name.trim()} loading={busy}>
            Create and open
          </Button>
        </Group>
      </form>
    </Stack>
  );
}

export function CompaniesModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <Modal opened={opened} onClose={onClose} title="Companies" size="lg">
      <CompaniesPanel />
    </Modal>
  );
}

/**
 * On every screen while in a test company (setup, "Who's working?", the app):
 * which company this is, and the way back. Also notices when the test company
 * this device remembers was deleted, and returns it to the main company.
 */
export function TestCompanyPill() {
  const list = useCompanies();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState(() => {
    try { return sessionStorage.getItem("pi.company-recovery") === "yes"; } catch { return false; }
  });
  const stored = companyId === "main" ? null : companyId;
  const gone = Boolean(stored && list.data && list.data.current !== stored);
  useEffect(() => {
    if (gone) {
      try { sessionStorage.setItem("pi.company-recovery", "yes"); } catch { /* Storage may be blocked. */ }
      switchCompany(null);
    }
  }, [gone]);
  const here = list.data?.companies.find((c) => c.id === list.data?.current);
  const recovery = notice && companyId === "main" ? (
    <Alert color="orange" title="Company changed" withCloseButton onClose={() => {
      setNotice(false);
      try { sessionStorage.removeItem("pi.company-recovery"); } catch { /* Storage may be blocked. */ }
    }} style={{ position: "fixed", top: 12, left: 12, right: 12, zIndex: 500 }}>
      That test company no longer exists. You're back in the main company.
    </Alert>
  ) : null;
  if (!stored || !here?.test) return recovery;
  return (
    <>
      {recovery}
      <button type="button" className="no-print test-company-pill" onClick={() => setOpen(true)} aria-label={`Test company ${here.name}. Switch company`}>
        Test company: {here.name} · Switch
      </button>
      <CompaniesModal opened={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function TestCompanyNotice() {
  const list = useCompanies();
  const here = list.data?.companies.find((c) => c.id === list.data?.current);
  if (!here?.test) return null;
  return (
    <Alert color="orange" title={`You're in the test company "${here.name}"`}>
      Everything here is separate from the main company.
    </Alert>
  );
}
