import { Button, CloseButton, Drawer, FileButton, Group, Menu, Popover, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconBug, IconBulb, IconCamera, IconCheck, IconEyeOff, IconHelp, IconList, IconMapPin, IconMessageReport, IconPhoto } from "@tabler/icons-react";
import { type PointerEvent, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Chips } from "../../components/onboarding/Onboarding";
import { toastErr, toastOk } from "../../components/ui";
import { get, patch, post } from "../../lib/api";
import { deviceContext } from "../../lib/diagnostics";
import { useProfile } from "../../lib/profile";
import type { Setup } from "../../lib/types";
import { type Anchor, anchorAt, locate, targetOf } from "./anchor";
import "./feedback.css";

export type Kind = "BUG" | "IDEA" | "QUESTION";
export type Note = { id: number; kind: Kind; status: "OPEN" | "DONE" | "WONTFIX"; note: string; path: string; pageTitle: string | null; anchor: Anchor | null; author: string; authorJob: string | null; hasScreenshot: boolean; createdAt: string; context: { viewport?: string; build?: string; errors?: unknown[] } };

export const KIND_LABEL: Record<Kind, string> = { BUG: "Bug", IDEA: "Idea", QUESTION: "Question" };
const KIND_OPTIONS = [
  { value: "BUG" as Kind, label: "Bug", icon: <IconBug size={20} /> },
  { value: "IDEA" as Kind, label: "Idea", icon: <IconBulb size={20} /> },
  { value: "QUESTION" as Kind, label: "Question", icon: <IconHelp size={20} /> },
];
const NAME_KEY = "pi.feedbackName";

/** A photo or capture, shrunk on the device to at most 1600px wide, as a JPEG data URL. */
async function shrink(source: CanvasImageSource & { width: number; height: number }): Promise<string> {
  const scale = Math.min(1, 1600 / source.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}
const fromFile = (file: File) => createImageBitmap(file).then(shrink);

/** One frame of this tab, through the browser's own "share your screen" prompt (laptops). */
async function captureTab(): Promise<string> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, preferCurrentTab: true } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 350));
    return await shrink(Object.assign(video, { width: video.videoWidth, height: video.videoHeight }));
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

/**
 * Beta feedback on every screen: a tab on the right edge; "Mark something"
 * drops a pin on what you tap and opens a note. Pins come back on the page
 * they were left on.
 */
export function FeedbackLayer() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile } = useProfile();
  const phone = useMediaQuery("(max-width: 640px)");
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => get<Setup>("/setup") });
  const notes = useQuery({ queryKey: ["feedback", pathname], queryFn: () => get<Note[]>(`/feedback?path=${encodeURIComponent(pathname)}&status=OPEN`) });
  const focus = Number(new URLSearchParams(search).get("feedback")) || null;

  const [hidden, setHidden] = useState(false);
  const [showPins, setShowPins] = useState(false);
  const [picking, setPicking] = useState(false);
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [draft, setDraft] = useState<Anchor | null>(null);
  const [kind, setKind] = useState<Kind>("BUG");
  const [text, setText] = useState("");
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [shot, setShot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (focus) setShowPins(true);
  }, [focus]);
  // Pages settle as their data loads: keep the pins on their elements.
  useEffect(() => {
    if (!showPins && !draft) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [showPins, draft]);

  if (hidden || pathname === "/test-sheet" || setup.data?.company.feedbackEnabled === false) return null;

  const under = (event: PointerEvent) => document.elementsFromPoint(event.clientX, event.clientY).find((el) => !el.closest(".fb-ui"));
  const pick = (event: PointerEvent) => {
    const el = under(event);
    if (!el) return;
    setDraft(anchorAt(targetOf(el), event.clientX, event.clientY));
    setPicking(false);
    setHover(null);
  };
  const close = () => {
    setDraft(null);
    setText("");
    setShot(null);
  };
  const send = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      if (!profile && name.trim()) localStorage.setItem(NAME_KEY, name.trim());
      await post("/feedback", {
        kind,
        note: text,
        path: pathname,
        pageTitle: document.querySelector("h1")?.textContent?.trim() || null,
        anchor: draft,
        context: deviceContext(),
        author: name.trim() || null,
        screenshot: shot,
      });
      toastOk("Thanks, your note was sent");
      close();
      setShowPins(true);
      await queryClient.invalidateQueries({ queryKey: ["feedback"] });
    } catch (error) {
      toastErr(error);
    } finally {
      setBusy(false);
    }
  };
  const capture = async () => {
    setCapturing(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      setShot(await captureTab());
    } catch {
      // Cancelled the browser's prompt: nothing to do.
    } finally {
      setCapturing(false);
    }
  };
  const resolve = async (id: number) => {
    try {
      await patch(`/feedback/${id}`, { status: "DONE" });
      await queryClient.invalidateQueries({ queryKey: ["feedback"] });
    } catch (error) {
      toastErr(error);
    }
  };

  const open = notes.data ?? [];
  const canCapture = !phone && typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const draftAt = draft ? locate(draft) : null;

  return (
    <div className="fb-ui no-print">
      <Menu position="left" offset={8} width={250} zIndex={1001}>
        <Menu.Target>
          <button type="button" className="fb-tab" aria-label="Feedback">
            <IconMessageReport size={20} />
            <span className="fb-tab-label">Feedback</span>
            {open.length ? <span className="fb-tab-count">{open.length}</span> : null}
          </button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconMapPin size={18} />} onClick={() => setPicking(true)}>
            Mark something on this page
          </Menu.Item>
          <Menu.Item leftSection={<IconMessageReport size={18} />} onClick={() => setShowPins(!showPins)}>
            {showPins ? "Hide notes on this page" : `Show notes on this page (${open.length})`}
          </Menu.Item>
          <Menu.Item leftSection={<IconList size={18} />} component={Link} to="/feedback">
            All feedback
          </Menu.Item>
          <Menu.Divider />
          <Menu.Item leftSection={<IconEyeOff size={18} />} onClick={() => setHidden(true)}>
            Hide until reload
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

      {picking ? (
        <div
          className="fb-overlay"
          onPointerMove={(event) => {
            const el = event.pointerType === "mouse" ? under(event) : null;
            setHover(el ? targetOf(el).getBoundingClientRect() : null);
          }}
          onClick={pick as never}
        >
          <div className="fb-banner" onClick={(event) => event.stopPropagation()}>
            <IconMapPin size={18} />
            <span>Tap what you want to comment on</span>
            <Button size="xs" variant="white" onClick={() => setPicking(false)}>
              Cancel
            </Button>
          </div>
          {hover ? <div className="fb-hover" style={{ left: hover.left, top: hover.top, width: hover.width, height: hover.height }} /> : null}
        </div>
      ) : null}

      {showPins
        ? open.map((note, i) => {
            if (!note.anchor) return null;
            const at = locate(note.anchor);
            return (
              <Popover key={note.id} position="bottom" withArrow width={300} defaultOpened={note.id === focus} withinPortal={false} zIndex={960}>
                <Popover.Target>
                  <button type="button" className="fb-pin" data-focus={note.id === focus || undefined} style={{ left: at.x, top: at.y }} aria-label={`Note ${i + 1}: ${note.note}`}>
                    {i + 1}
                  </button>
                </Popover.Target>
                <Popover.Dropdown>
                  <Text size="xs" c="dimmed">
                    {KIND_LABEL[note.kind]} · {note.author} · {new Date(note.createdAt).toLocaleString()}
                  </Text>
                  <Text size="sm" mt={4} style={{ whiteSpace: "pre-wrap" }}>
                    {note.note}
                  </Text>
                  <Group gap="xs" mt="sm">
                    <Button size="xs" variant="default" leftSection={<IconCheck size={14} />} onClick={() => resolve(note.id)}>
                      Mark done
                    </Button>
                    <Button size="xs" variant="subtle" onClick={() => navigate("/feedback")}>
                      All feedback
                    </Button>
                  </Group>
                </Popover.Dropdown>
              </Popover>
            );
          })
        : null}
      {draftAt ? <span className="fb-pin" data-draft="true" style={{ left: draftAt.x, top: draftAt.y }} /> : null}

      <Drawer
        opened={draft != null && !capturing}
        onClose={close}
        position={phone ? "bottom" : "right"}
        size={phone ? "auto" : 400}
        title="Leave a note"
        overlayProps={{ backgroundOpacity: phone ? 0.3 : 0 }}
        lockScroll={phone}
        zIndex={1002}
        className="fb-ui"
      >
        <Stack gap="md">
          {draft?.label ? (
            <Text size="sm" c="dimmed" lineClamp={2}>
              On “{draft.label}”
            </Text>
          ) : null}
          <Chips label="Kind of note" value={kind} onChange={setKind} options={KIND_OPTIONS} />
          <Textarea label="What happened, and what did you expect?" autosize minRows={4} value={text} onChange={(e) => setText(e.currentTarget.value)} data-autofocus />
          {!profile ? <TextInput label="Your name" value={name} onChange={(e) => setName(e.currentTarget.value)} /> : null}
          {shot ? (
            <div className="fb-shot">
              <img src={shot} alt="Screenshot to send" />
              <CloseButton aria-label="Remove screenshot" onClick={() => setShot(null)} />
            </div>
          ) : (
            <Group gap="xs">
              {canCapture ? (
                <Button variant="default" leftSection={<IconCamera size={18} />} onClick={capture}>
                  Capture this screen
                </Button>
              ) : null}
              <FileButton accept="image/*" onChange={(file) => file && fromFile(file).then(setShot).catch(toastErr)}>
                {(props) => (
                  <Button {...props} variant="default" leftSection={<IconPhoto size={18} />}>
                    Attach an image
                  </Button>
                )}
              </FileButton>
            </Group>
          )}
          <Text size="xs" c="dimmed">
            We'll include this page, your screen size, browser and any recent errors.
          </Text>
          <Button size="md" onClick={send} loading={busy} disabled={!text.trim()}>
            Send
          </Button>
        </Stack>
      </Drawer>
    </div>
  );
}
