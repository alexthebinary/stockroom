import { useEffect, useRef, useState } from "react";
import { Box, Button, Group, Stack, Text } from "@mantine/core";
import { IconBolt, IconCamera, IconX } from "@tabler/icons-react";

/**
 * Camera capture for a shipping label.
 *
 * The viewfinder STAYS OPEN between captures. A modal that closes on every scan
 * turns a pallet of forty boxes into forty open-and-dismiss cycles, which is the
 * single biggest difference between a tool a warehouse uses and one it abandons.
 *
 * Two readers are combined:
 *   - BarcodeDetector, where the browser has it (Chrome/Android). Free, instant,
 *     check-digited — it outranks any vision model.
 *   - A JPEG frame posted to the server, read by two vision models.
 * Both go to the same adjudicator, which counts agreement by model family.
 */

type Props = {
  open: boolean;
  onClose: () => void;
  onCapture: (payload: { image: string; barcode?: string }) => void;
  busy?: boolean;
  /** Last result, shown in the console strip so the clerk never loses their place. */
  status?: { tone: "ok" | "warn" | "retry"; text: string } | null;
  scannedCount?: number;
};

export function LabelScanner({ open, onClose, onCapture, busy, status, scannedCount = 0 }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // The rear camera, and a resolution high enough that small serial
          // digits survive JPEG compression.
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch (e: any) {
        setError(
          e?.name === "NotAllowedError"
            ? "Camera permission denied. Allow it in your browser settings."
            : "No camera available on this device."
        );
      }
    })();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as any] });
      setTorchOn((t) => !t);
    } catch {
      // Torch is unsupported on most desktops and some phones. Silently
      // ignoring is right — the button simply does nothing rather than
      // throwing an error at someone holding a box.
    }
  }

  async function capture() {
    const video = videoRef.current;
    if (!video || busy) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL("image/jpeg", 0.75);

    // A barcode read is free and outranks every vision model, so try it first.
    let barcode: string | undefined;
    const Detector = (window as any).BarcodeDetector;
    if (Detector) {
      try {
        const det = new Detector({ formats: ["code_128", "code_39", "qr_code", "data_matrix", "ean_13"] });
        const found = await det.detect(canvas);
        if (found?.length) barcode = String(found[0].rawValue);
      } catch {
        // Detector present but unable to decode this frame — not an error,
        // just no barcode leg on this scan.
      }
    }

    // Haptic confirmation: the clerk is not looking at the screen.
    navigator.vibrate?.(60);
    onCapture({ image, barcode });
  }

  if (!open) return null;

  const toneColour =
    status?.tone === "ok" ? "#12b886" : status?.tone === "warn" ? "#f59f00" : "#868e96";

  return (
    <Box
      style={{
        position: "fixed", inset: 0, zIndex: 400, background: "#000",
        display: "flex", flexDirection: "column",
      }}
    >
      <Box style={{ flex: "1 1 65%", position: "relative", overflow: "hidden" }}>
        {error ? (
          <Stack align="center" justify="center" h="100%" p="lg">
            <Text c="white" ta="center">{error}</Text>
            <Button variant="white" onClick={onClose}>Back</Button>
          </Stack>
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
            {/* Reticle: a frame to aim the label into, not decoration. */}
            <Box
              style={{
                position: "absolute", left: "8%", right: "8%", top: "28%", height: "30%",
                border: `3px solid ${status?.tone === "ok" ? "#12b886" : "rgba(255,255,255,0.85)"}`,
                borderRadius: 12, pointerEvents: "none",
                transition: "border-color 140ms ease",
              }}
            />
            <Group style={{ position: "absolute", top: 12, left: 12, right: 12 }} justify="space-between">
              <Button size="compact-sm" variant="white" leftSection={<IconX size={16} />} onClick={onClose}>
                Done
              </Button>
              <Group gap={8}>
                <Text c="white" fw={700}>{scannedCount} scanned</Text>
                <Button size="compact-sm" variant={torchOn ? "white" : "default"} onClick={toggleTorch}>
                  <IconBolt size={16} />
                </Button>
              </Group>
            </Group>
          </>
        )}
      </Box>

      {/* Console strip — what just happened, without leaving the camera. */}
      <Box style={{ flex: "0 0 35%", background: "#111", padding: 16 }}>
        <Stack gap="sm" h="100%" justify="space-between">
          <Box style={{ minHeight: 48 }}>
            {status && (
              <Text c={toneColour} fw={600} size="lg">{status.text}</Text>
            )}
            {!status && <Text c="dimmed">Aim at the serial label and tap Scan.</Text>}
          </Box>
          <Button
            fullWidth size="xl" h={64} color="teal"
            leftSection={<IconCamera size={26} />}
            loading={busy}
            onClick={capture}
            disabled={Boolean(error)}
          >
            Scan
          </Button>
        </Stack>
      </Box>
    </Box>
  );
}
