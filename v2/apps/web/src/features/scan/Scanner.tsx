import { ActionIcon, Box, Button, Group, Stack, Text, TextInput } from "@mantine/core";
import { IconBolt, IconBoltOff, IconCamera, IconKeyboard, IconX } from "@tabler/icons-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { signal } from "./feedback";

export type ScanFeedback = "ok" | "warn" | "error";

type Props = {
  /** Called once per new code. Return how it went, for the flash and the buzz. */
  onScan: (code: string) => Promise<ScanFeedback> | ScanFeedback;
  onClose: () => void;
  /** What the bar at the bottom says: the running count, the next instruction. */
  children?: ReactNode;
  prompt?: string;
  /** Ask the scanner for a still (a packing slip, a label) instead of a code. */
  onPhoto?: (dataUrl: string) => void;
};

type Detector = { detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]> };

/**
 * The camera, full screen, open between scans: aim, it reads, it buzzes, aim
 * at the next box. Decodes ~8 frames a second from the aiming frame only,
 * using the phone's own BarcodeDetector where there is one (Android) and the
 * bundled WebAssembly decoder everywhere else (iPhone). A code that stays in
 * view counts once; it counts again only after leaving the frame.
 */
export function Scanner({ onScan, onClose, children, prompt, onPhoto }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const worker = useRef<Worker | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const busy = useRef(false);
  const last = useRef<{ code: string; at: number } | null>(null);
  const handler = useRef(onScan);
  handler.current = onScan;
  const [state, setState] = useState<"idle" | ScanFeedback>("idle");
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");

  const deliver = useCallback(async (code: string) => {
    // One box held in view is one scan: the same code counts again only after
    // it has been out of view for 1.5 s (the clerk moved to the next box).
    const now = Date.now();
    const seenRecently = last.current && last.current.code === code && now - last.current.at < 1500;
    last.current = { code, at: now };
    if (seenRecently) return;
    const result = await handler.current(code);
    setState(result);
    signal(result);
    setTimeout(() => setState("idle"), 700);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const native: Detector | null =
      "BarcodeDetector" in window
        ? new (window as unknown as { BarcodeDetector: new (o: object) => Detector }).BarcodeDetector({
            formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code", "data_matrix"],
          })
        : null;
    worker.current = new Worker(new URL("./decoder.worker.ts", import.meta.url), { type: "module" });
    let requestId = 0;
    worker.current.onmessage = (event: MessageEvent<{ id: number; text: string | null }>) => {
      busy.current = false;
      if (event.data.text) void deliver(event.data.text);
    };

    const tick = async () => {
      if (stopped) return;
      const v = video.current;
      if (v && v.readyState >= 2 && !busy.current) {
        // Only the aiming frame: smaller to decode, and it ignores the label next door.
        const w = v.videoWidth;
        const h = v.videoHeight;
        const crop = { x: Math.round(w * 0.05), y: Math.round(h * 0.25), w: Math.round(w * 0.9), h: Math.round(h * 0.32) };
        canvas.current ??= document.createElement("canvas");
        const c = canvas.current;
        c.width = crop.w;
        c.height = crop.h;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(v, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
        busy.current = true;
        try {
          const hits = native ? await native.detect(c) : [];
          if (hits[0]?.rawValue) {
            busy.current = false;
            void deliver(hits[0].rawValue);
          } else {
            const image = ctx.getImageData(0, 0, c.width, c.height);
            worker.current?.postMessage({ id: ++requestId, image }, [image.data.buffer]);
          }
        } catch {
          busy.current = false;
        }
      }
      timer = setTimeout(tick, 120);
    };

    (async () => {
      try {
        const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        if (stopped) return media.getTracks().forEach((t) => t.stop());
        stream.current = media;
        const track = media.getVideoTracks()[0];
        const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
        if (caps.torch) setTorch(false);
        if (video.current) {
          video.current.srcObject = media;
          await video.current.play().catch(() => {});
        }
        tick();
      } catch (err) {
        const name = (err as Error).name;
        setError(
          name === "NotAllowedError"
            ? "Camera access was refused. Allow the camera for this site in your browser settings, or type the code instead."
            : !window.isSecureContext
              ? "The camera needs a secure (https) connection."
              : "No camera is available. Type the code instead.",
        );
        setTyping(true);
      }
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
      worker.current?.terminate();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, [deliver]);

  const toggleTorch = async () => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torch;
    await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] }).catch(() => {});
    setTorch(next);
  };

  const photo = () => {
    const v = video.current;
    if (!v || !onPhoto) return;
    const c = document.createElement("canvas");
    const scale = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    onPhoto(c.toDataURL("image/jpeg", 0.82));
  };

  const submitTyped = () => {
    const code = typed.trim();
    if (!code) return;
    setTyped("");
    last.current = null;
    void deliver(code);
  };

  return (
    <div className="scanner" role="dialog" aria-label="Scanner">
      <Box pos="relative" style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <video ref={video} playsInline muted aria-label="Camera view" />
        <div className="scanner-frame" data-state={state === "idle" ? undefined : state} />
        <Group pos="absolute" top={12} left={12} right={12} justify="space-between" style={{ paddingTop: "env(safe-area-inset-top)" }}>
          <ActionIcon size={48} variant="filled" color="dark" onClick={onClose} aria-label="Close scanner">
            <IconX />
          </ActionIcon>
          <Group gap="xs">
            {torch !== null ? (
              <ActionIcon size={48} variant="filled" color="dark" onClick={toggleTorch} aria-label={torch ? "Torch off" : "Torch on"}>
                {torch ? <IconBoltOff /> : <IconBolt />}
              </ActionIcon>
            ) : null}
            <ActionIcon size={48} variant="filled" color="dark" onClick={() => setTyping((t) => !t)} aria-label="Type a code">
              <IconKeyboard />
            </ActionIcon>
          </Group>
        </Group>
        {prompt ? (
          <Text pos="absolute" top="20%" left={0} right={0} ta="center" c="white" fw={600} size="lg" style={{ textShadow: "0 1px 4px #000" }}>
            {prompt}
          </Text>
        ) : null}
      </Box>
      <div className="scanner-bar">
        <Stack gap="sm">
          {error ? (
            <Text size="sm" c="orange.3">
              {error}
            </Text>
          ) : null}
          {typing ? (
            <Group gap="xs" wrap="nowrap">
              <TextInput
                aria-label="Code"
                placeholder="Type or paste a barcode, SKU or serial"
                value={typed}
                onChange={(e) => setTyped(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && submitTyped()}
                style={{ flex: 1 }}
                size="md"
                autoFocus
              />
              <Button size="md" onClick={submitTyped}>
                Add
              </Button>
            </Group>
          ) : null}
          {children}
          <Group grow>
            {onPhoto ? (
              <Button size="lg" variant="default" leftSection={<IconCamera />} onClick={photo}>
                Photo
              </Button>
            ) : null}
            <Button size="lg" color="lime.4" onClick={onClose}>
              Done scanning
            </Button>
          </Group>
        </Stack>
      </div>
    </div>
  );
}
