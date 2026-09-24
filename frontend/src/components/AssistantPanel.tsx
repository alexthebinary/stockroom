import { useState, useRef, useEffect } from 'react';
import {
  ActionIcon,
  Drawer,
  ScrollArea,
  Textarea,
  Button,
  Paper,
  Card,
  Badge,
  Loader,
  Group,
  Stack,
  Text,
  Image as MantineImage,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { IconSparkles, IconCamera, IconSend, IconX } from '@tabler/icons-react';
import { api, streamPost } from '../api';
import { toastOk, toastErr } from './ui';

interface Proposal {
  id: string;
  title: string;
  summary: string;
  method: 'POST';
  path: string;
  body: unknown;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface UserDisplayMessage {
  id: string;
  role: 'user';
  content: string;
  image?: string;
}

interface AssistantDisplayMessage {
  id: string;
  role: 'assistant';
  content: string;
  proposals?: Proposal[];
  looked?: string[];
  /** Answered by the Jev front door (a screen link or a wiki page), not the model. */
  fast?: boolean;
  navigate?: { to: string; label: string };
  /** The question this answered, so "Ask the assistant instead" can resend it. */
  question?: string;
}

type DisplayMessage = UserDisplayMessage | AssistantDisplayMessage;

interface ProposalState {
  status: 'pending' | 'approved' | 'dismissed' | 'error';
  error?: string;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

async function compressToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        const max = 1280;
        if (width > height && width > max) {
          height = Math.round((height * max) / width);
          width = max;
        } else if (height > max) {
          width = Math.round((width * max) / height);
          height = max;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas context unavailable'));
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function AssistantPanel() {
  const [opened, setOpened] = useState(false);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // A photo turn takes ~15 s. Naming the stage it is probably in makes that
  // feel like progress instead of a hang; the stages follow the measured
  // shape of a delivery turn (read the slip → look up the PO → prepare).
  const [stage, setStage] = useState(0);
  const [stagesFor, setStagesFor] = useState<string[]>([]);
  useEffect(() => {
    if (!isLoading) {
      setStage(0);
      return;
    }
    const t = setInterval(() => setStage((n) => n + 1), 4000);
    return () => clearInterval(t);
  }, [isLoading]);
  // What the assistant is doing right now, and the reply as it is written.
  // Both come from the stream; the timed stages above are only the fallback
  // until the first real status arrives.
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [proposalStates, setProposalStates] = useState<Record<string, ProposalState>>({});

  const isMobile = useMediaQuery('(max-width: 48em)');
  // No button at all when the server has no model configured: a button that
  // only ever answers "not available" is worse than none.
  const status = useQuery({
    queryKey: ['assistant-status'],
    queryFn: () => api.get<{ configured: boolean }>('/assistant/status'),
    staleTime: 5 * 60_000,
  });
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages or loading state
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  const apiMessages: ChatMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.content || (m.role === 'user' && 'image' in m && m.image ? '(photo attached)' : ''),
  }));

  const inFlight = useRef(false);
  async function sendMessage(text?: string, imageOverride?: string, full = false) {
    // One turn at a time: a second send mid-answer interleaves two replies and
    // gives the second turn the first one's reads (seen on the live app when a
    // script bypassed the disabled composer).
    if (inFlight.current) return;
    const content = (text ?? input).trim();
    const imageToSend = imageOverride ?? attachedImage;

    if (!content && !imageToSend) return;

    const userMsg: UserDisplayMessage = {
      id: generateId(),
      role: 'user',
      content,
      ...(imageToSend && { image: imageToSend }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setAttachedImage(null);
    setStagesFor(
      imageToSend
        ? ['Reading the photo…', 'Looking up the order…', 'Comparing with what was ordered…', 'Preparing it for you to approve…']
        : ['Thinking…', 'Checking the app…', 'Almost there…']
    );
    setIsLoading(true);
    inFlight.current = true;

    try {
      // A quick answer only makes sense at the start of a conversation or right
      // after another quick answer; a reply like "yes, do it" needs the model
      // that knows what "it" is.
      const last = [...messages].reverse().find((m) => m.role === 'assistant') as AssistantDisplayMessage | undefined;
      const payload: {
        messages: ChatMessage[];
        route: string;
        image?: string;
        full?: boolean;
        fastOk?: boolean;
      } = {
        messages: [...apiMessages, { role: 'user', content: content || '(photo attached)' }],
        route: location.pathname,
        full,
        fastOk: !last || Boolean(last.fast),
      };
      if (imageToSend) payload.image = imageToSend;

      setLiveStatus(null);
      setDraft('');
      const res = await streamPost<{
        reply: string;
        proposals: Proposal[];
        looked: string[];
        fast?: boolean;
        navigate?: { to: string; label: string };
      }>('/assistant/chat/stream', payload, (e) => {
        if (e.type === 'status' && e.text) setLiveStatus(e.text);
        else if (e.type === 'text' && e.text) setDraft((d) => d + e.text);
        else if (e.type === 'reset') setDraft('');
      });

      const assistantMsg: AssistantDisplayMessage = {
        id: generateId(),
        role: 'assistant',
        content: res.reply,
        proposals: res.proposals,
        looked: res.fast ? [] : res.looked,
        fast: res.fast,
        navigate: res.navigate,
        question: content,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: unknown) {
      const error = err as { message?: string; status?: number };
      if (error.status === 503 || error.message?.includes('503')) {
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: 'assistant',
            content: `The assistant is not available right now: ${error.message || 'Service unavailable'}`,
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: generateId(),
            role: 'assistant',
            content: `Error: ${error.message || 'Request failed'}`,
          },
        ]);
      }
    } finally {
      inFlight.current = false;
      setIsLoading(false);
      setLiveStatus(null);
      setDraft('');
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressToDataUrl(file);
      setAttachedImage(dataUrl);
    } catch {
      toastErr(new Error('Failed to process image'));
    }
    e.target.value = '';
  }

  async function handleApprove(proposal: Proposal) {
    const currentState = proposalStates[proposal.id];
    if (currentState?.status === 'approved' || currentState?.status === 'dismissed') return;

    try {
      await api.post(proposal.path, proposal.body);
      setProposalStates((prev) => ({
        ...prev,
        [proposal.id]: { status: 'approved' },
      }));
      queryClient.invalidateQueries();
      toastOk(`${proposal.title} — done`);
    } catch (err: unknown) {
      const error = err as Error;
      setProposalStates((prev) => ({
        ...prev,
        [proposal.id]: { status: 'error', error: error.message },
      }));
      toastErr(error);
    }
  }

  function handleDismiss(proposalId: string) {
    setProposalStates((prev) => ({
      ...prev,
      [proposalId]: { status: 'dismissed' },
    }));
  }

  function renderProposal(proposal: Proposal) {
    const state = proposalStates[proposal.id] || { status: 'pending' as const };

    if (state.status === 'approved') {
      return <Badge color="green" variant="light">Done</Badge>;
    }
    if (state.status === 'dismissed') {
      return <Badge color="gray" variant="light">Dismissed</Badge>;
    }

    return (
      <Stack gap={4}>
        {state.status === 'error' && (
          <Text c="red" size="xs">{state.error}</Text>
        )}
        <Group gap="xs">
          <Button size="xs" onClick={() => handleApprove(proposal)}>
            Approve
          </Button>
          <Button size="xs" variant="subtle" onClick={() => handleDismiss(proposal.id)}>
            Dismiss
          </Button>
        </Group>
      </Stack>
    );
  }

  const suggestions = [
    'What should I do on this page?',
    'What needs attention today?',
    'I have a delivery to receive',
  ];

  if (!status.data?.configured) return null;

  return (
    <>
      <ActionIcon
        aria-label="Open the assistant"
        // WHY: floating trigger must stay above bottom nav on mobile
        style={{
          position: 'fixed',
          right: 16,
          bottom: 'calc(16px + var(--bottom-bar-h, 0px) + var(--dock-h, 0px))',
          zIndex: 210,
        }}
        size="xl"
        radius="xl"
        variant="filled"
        onClick={() => setOpened(true)}
      >
        <IconSparkles size={22} />
      </ActionIcon>

      <Drawer
        opened={opened}
        onClose={() => setOpened(false)}
        position="right"
        size={isMobile ? '100%' : 'md'}
        title="Assistant"
        // WHY: full width on phones for fat-finger comfort
      >
        <Stack h="100%" style={{ display: 'flex', flexDirection: 'column' }}>
          <ScrollArea
            style={{ flex: 1 }}
            viewportRef={viewportRef}
            p="md"
            offsetScrollbars
          >
            {messages.length === 0 && (
              <Stack gap="md">
                <Text size="sm" c="dimmed">
                  I can explain any screen, find records, and prepare work for you to approve.
                </Text>
                <Group gap="xs">
                  {suggestions.map((s, i) => (
                    <Button
                      key={i}
                      variant="light"
                      size="compact-sm"
                      onClick={() => sendMessage(s)}
                      disabled={isLoading}
                    >
                      {s}
                    </Button>
                  ))}
                </Group>
              </Stack>
            )}

            {messages.map((msg) => {
              if (msg.role === 'user') {
                return (
                  <Group key={msg.id} justify="flex-end" mb="xs">
                    <Paper
                      p="xs"
                      radius="md"
                      style={{ maxWidth: '80%', backgroundColor: 'var(--mantine-color-blue-light)' }}
                    >
                      {msg.image && (
                        <MantineImage
                          src={msg.image}
                          w={60}
                          h={60}
                          fit="cover"
                          radius="sm"
                          mb={msg.content ? 'xs' : 0}
                        />
                      )}
                      {msg.content && (
                        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                          {msg.content}
                        </Text>
                      )}
                    </Paper>
                  </Group>
                );
              }

              return (
                <Stack key={msg.id} gap="xs" mb="sm">
                  <Paper
                    p="xs"
                    radius="md"
                    style={{ backgroundColor: 'var(--mantine-color-default-hover)' }}
                  >
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                      {msg.content}
                    </Text>
                  </Paper>

                  {msg.role === 'assistant' && (msg as AssistantDisplayMessage).navigate && (
                    <Button
                      size="compact-sm"
                      onClick={() => {
                        navigate((msg as AssistantDisplayMessage).navigate!.to);
                        if (isMobile) setOpened(false);
                      }}
                    >
                      Open {(msg as AssistantDisplayMessage).navigate!.label}
                    </Button>
                  )}

                  {msg.role === 'assistant' && (msg as AssistantDisplayMessage).fast && (
                    <Button
                      variant="subtle"
                      size="compact-xs"
                      color="gray"
                      onClick={() => sendMessage((msg as AssistantDisplayMessage).question ?? '', undefined, true)}
                    >
                      Not what you meant? Ask the assistant instead
                    </Button>
                  )}

                  {msg.looked && msg.looked.length > 0 && (
                    <Text size="xs" c="dimmed">
                      Checked: {msg.looked.join(', ')}
                    </Text>
                  )}

                  {msg.proposals && msg.proposals.length > 0 && (
                    <Stack gap="xs">
                      {msg.proposals.map((p) => (
                        <Card key={p.id} withBorder p="xs">
                          <Text fw={600} size="sm">{p.title}</Text>
                          <Text size="sm" c="dimmed" mb="xs">{p.summary}</Text>
                          {renderProposal(p)}
                        </Card>
                      ))}
                    </Stack>
                  )}
                </Stack>
              );
            })}

            {isLoading && draft && (
              <Text size="sm" mb="xs" style={{ whiteSpace: 'pre-wrap' }} aria-live="polite">
                {/* The server strips markdown from the final reply; do the same while it streams. */}
                {draft.replace(/\*\*/g, '').replace(/^#{1,6}\s*/gm, '')}
              </Text>
            )}

            {isLoading && !draft && (
              <Group gap="xs" mb="xs">
                <Paper p="xs" radius="md" style={{ backgroundColor: 'var(--mantine-color-default-hover)' }}>
                  <Group gap="xs">
                    <Loader size="xs" />
                    <Text size="sm" c="dimmed">
                      {liveStatus ??
                        (stagesFor.length ? stagesFor : ['Thinking…'])[Math.min(stage, Math.max(stagesFor.length - 1, 0))]}
                    </Text>
                  </Group>
                </Paper>
              </Group>
            )}

            <div ref={bottomRef} />
          </ScrollArea>

          {/* Composer */}
          <Stack gap="xs" p="md" style={{ borderTop: '1px solid var(--mantine-color-gray-3)' }}>
            {attachedImage && (
              <Group gap="xs" align="flex-start">
                <div style={{ position: 'relative' }}>
                  <MantineImage src={attachedImage} w={60} h={60} fit="cover" radius="sm" />
                  <ActionIcon
                    size="xs"
                    variant="filled"
                    color="red"
                    style={{ position: 'absolute', top: -4, right: -4 }}
                    onClick={() => setAttachedImage(null)}
                  >
                    <IconX size={12} />
                  </ActionIcon>
                </div>
              </Group>
            )}

            <Group gap="xs" align="flex-end">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: 'none' }}
                onChange={handleFileChange}
              />
              <ActionIcon
                variant="subtle"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading}
              >
                <IconCamera size={18} />
              </ActionIcon>

              <Textarea
                value={input}
                onChange={(e) => setInput(e.currentTarget.value)}
                placeholder="Ask, or attach a delivery photo"
                autosize
                maxRows={4}
                style={{ flex: 1 }}
                disabled={isLoading}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
              />

              <ActionIcon
                variant="filled"
                onClick={() => sendMessage()}
                disabled={isLoading || (!input.trim() && !attachedImage)}
              >
                <IconSend size={18} />
              </ActionIcon>
            </Group>
          </Stack>
        </Stack>
      </Drawer>
    </>
  );
}
