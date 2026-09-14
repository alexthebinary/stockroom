import { Alert, Button, Card, Center, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";
import { useState } from "react";
import { useAuth } from "../auth";
import { errorMessage } from "../components/ui";

/** Hard-coded demo login. No reset, no session, no token. */
export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("demo@user.com");
  const [password, setPassword] = useState("password");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // `w={380}` was a fixed width, so at 390px the card sat 5px from each edge
  // with no gutter. A max-width plus page padding keeps the card its intended
  // size on a desktop and lets it shrink on a phone.
  return (
    <Center mih="100vh" p="md" bg="var(--mantine-color-gray-0)">
      <Card withBorder shadow="sm" radius="md" p="xl" w="100%" maw={380}>
        <form onSubmit={submit}>
          <Stack>
            <Stack gap={2}>
              <Title order={3}>Stockroom</Title>
              <Text size="sm" c="dimmed">
                Inventory demo — sign in with the demo account.
              </Text>
            </Stack>
            {error && <Alert color="red">{error}</Alert>}
            <TextInput
              label="Email"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              autoComplete="username"
            />
            <PasswordInput
              label="Password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              autoComplete="current-password"
            />
            <Button type="submit" loading={busy} fullWidth>
              Sign in
            </Button>
            <Text size="xs" c="dimmed" ta="center">
              demo@user.com / password
            </Text>
          </Stack>
        </form>
      </Card>
    </Center>
  );
}
