/// <reference lib="webworker" />
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

/**
 * Barcode decoding off the main thread, with zxing-cpp compiled to WebAssembly.
 * It reads what iOS Safari can't (there is no BarcodeDetector on iPhone):
 * UPC/EAN, Code 128/39, ITF, QR, Data Matrix — including GS1 labels with a
 * serial. The .wasm ships with the app, so scanning works with no signal.
 */
prepareZXingModule({
  overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
  fireImmediately: true,
});

self.onmessage = async (event: MessageEvent<{ id: number; image: ImageData }>) => {
  const { id, image } = event.data;
  try {
    const results = await readBarcodes(image, {
      formats: ["EAN13", "EAN8", "UPCA", "UPCE", "Code128", "Code39", "ITF", "QRCode", "DataMatrix"],
      tryHarder: true,
      maxNumberOfSymbols: 1,
    });
    const hit = results.find((r) => r.isValid && r.text);
    self.postMessage({ id, text: hit?.text ?? null, format: hit?.format ?? null });
  } catch (error) {
    self.postMessage({ id, text: null, format: null, error: String(error) });
  }
};
