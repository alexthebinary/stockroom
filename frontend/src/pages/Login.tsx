import { Alert, Button, Card, Center, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";
import { useState } from "react";
import { useAuth } from "../auth";
import { errorMessage } from "../components/ui";

/**
 * Sign-in.
 *
 * The fields start EMPTY and there is no credential hint. Both used to be
 * prefilled with `demo@user.com` / `password`, an account that exists in
 * neither the local nor the production database — so the first thing anyone
 * did in this product was submit a credential that fails. It was quoted into
 * a design brief as current and cost a day, then blocked two separate
 * reviewers in one session. A hint that is wrong is worse than no hint.
 */
export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
                Sign in to continue.
              </Text>
            </Stack>
            {error && <Alert color="red">{error}</Alert>}
            <TextInput
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              autoComplete="username"
              required
              autoFocus
            />
            <PasswordInput
              label="Password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              autoComplete="current-password"
              required
            />
            <Button type="submit" loading={busy} fullWidth disabled={!email || !password}>
              Sign in
            </Button>
            {/*
              A free instance sleeps after 15 minutes and takes ~30s to wake,
              and the spinner alone reads as a hang on the first sign-in of the
              day. Saying so costs nothing and stops people re-submitting.
            */}
            {busy && (
              <Text size="xs" c="dimmed" ta="center">
                Waking the server — the first sign-in of the day can take up to
                30 seconds.
              </Text>
            )}
          </Stack>
        </form>
      </Card>
    </Center>
  );
}
