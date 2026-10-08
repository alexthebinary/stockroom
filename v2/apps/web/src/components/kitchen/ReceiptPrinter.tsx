import { IconCircleCheckFilled, IconLoader2 } from "@tabler/icons-react";
import type { ReactNode } from "react";

/**
 * A small receipt printer: a status screen while the delivery is recorded,
 * then the WH-IN receipt feeds out line by line. Adapted from dqnamo's
 * Kitchen; the stepped feed is CSS, and reduced motion prints instantly.
 */
export type PrinterStage = "processing" | "printing" | "complete";

const LABEL: Record<PrinterStage, string> = {
  processing: "Recording the delivery",
  printing: "Printing the receipt",
  complete: "Delivery received",
};

export function ReceiptPrinter({ stage, status, children }: { stage: PrinterStage; status?: ReactNode; children: ReactNode }) {
  return (
    <section className="printer" data-stage={stage} aria-label="Warehouse receipt">
      <div className="printer-machine">
        <div className="printer-screen">
          <span className="printer-indicator" aria-hidden="true">
            {stage === "complete" ? <IconCircleCheckFilled size={18} /> : <IconLoader2 size={18} className="printer-spin" />}
          </span>
          <span role="status" aria-live="polite" className="printer-status">
            {status ?? LABEL[stage]}
          </span>
        </div>
        <span className="printer-slot" aria-hidden="true" />
      </div>
      <div className="printer-output">
        {stage !== "processing" ? <span className="printer-shadow" aria-hidden="true" /> : null}
        <article className="printer-paper" aria-hidden={stage !== "complete"}>
          {children}
        </article>
      </div>
    </section>
  );
}
