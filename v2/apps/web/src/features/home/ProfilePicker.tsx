import { Button, Card, Center, Container, Group, SegmentedControl, SimpleGrid, Stack, Text, TextInput, Title, UnstyledButton } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toastErr } from "../../components/ui";
import { get, type Job, post, type Profile } from "../../lib/api";
import { JOB_LABEL, useProfile } from "../../lib/profile";

const JOB_HINT: Record<Job, string> = {
  CLERK: "Receive deliveries with the camera",
  ACCOUNTING: "Review bills, freight and payables",
  ADMIN: "Orders, settings and the books",
};

/** "Who's working?" — tap your name. No password (operator decision); it signs your work. */
export function ProfilePicker() {
  const { choose } = useProfile();
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => get<Profile[]>("/profiles") });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [job, setJob] = useState<Job>("CLERK");

  const add = async () => {
    try {
      const created = await post<Profile>("/profiles", { name, job });
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
      choose(created);
    } catch (error) {
      toastErr(error);
    }
  };

  return (
    <Container size={520} py={48}>
      <Stack gap="lg">
        <Center>
          <img src="/icon.svg" width={56} height={56} alt="" style={{ borderRadius: 14 }} />
        </Center>
        <Title order={1} ta="center">
          Who's working?
        </Title>
        <SimpleGrid cols={{ base: 1, xs: 2 }}>
          {(profiles.data ?? []).map((p) => (
            <UnstyledButton key={p.id} onClick={() => choose(p)} aria-label={`${p.name}, ${JOB_LABEL[p.job]}`}>
              <Card withBorder padding="lg" radius="md" style={{ minHeight: 88 }}>
                <Text fw={600} size="lg">
                  {p.name}
                </Text>
                <Text size="sm" c="dimmed">
                  {JOB_LABEL[p.job]}
                </Text>
              </Card>
            </UnstyledButton>
          ))}
        </SimpleGrid>
        {adding || profiles.data?.length === 0 ? (
          <Card withBorder padding="lg">
            <Stack>
              <TextInput label="Your name" value={name} onChange={(e) => setName(e.currentTarget.value)} size="md" autoFocus data-autofocus />
              <div>
                <Text size="sm" fw={500} mb={6}>
                  What do you do here?
                </Text>
                <SegmentedControl fullWidth value={job} onChange={(v) => setJob(v as Job)} data={(["CLERK", "ACCOUNTING", "ADMIN"] as Job[]).map((j) => ({ value: j, label: JOB_LABEL[j] }))} />
                <Text size="sm" c="dimmed" mt={6}>
                  {JOB_HINT[job]}
                </Text>
              </div>
              <Button size="md" onClick={add} disabled={!name.trim()}>
                Continue
              </Button>
            </Stack>
          </Card>
        ) : (
          <Group justify="center">
            <Button variant="subtle" onClick={() => setAdding(true)}>
              I'm not on the list
            </Button>
          </Group>
        )}
      </Stack>
    </Container>
  );
}
