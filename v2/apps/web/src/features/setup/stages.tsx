import { IconCircleCheckFilled } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Avatar } from "../../components/onboarding/Onboarding";
import { ReceiptPrinter, type PrinterStage } from "../../components/kitchen/ReceiptPrinter";
import { usd } from "../../components/ui";
import type { Job } from "../../lib/api";
import { JOB_LABEL } from "../../lib/profile";

/*
 * What the stage shows beside each setup question: a live picture of the
 * thing being built, printed on the same paper as the warehouse receipts.
 */

const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2026, i, 1).toLocaleString("en-US", { month: "long" }));

/** The product in three pieces of paper: a delivery counted, its bill, paid. */
export function WelcomeStage() {
  return (
    <>
      <div className="ob-paper" style={{ maxWidth: 340, justifySelf: "start" }}>
        <div className="ob-paper-label">Delivery · WH-IN-00001</div>
        <div className="ob-bars" style={{ margin: "14px 0 12px" }} />
        <div className="ob-paper-row">
          <span>Sample Widget</span>
          <b>2 counted</b>
        </div>
      </div>
      <div className="ob-paper" style={{ maxWidth: 360, justifySelf: "end" }}>
        <div className="ob-paper-label">Bill · Sample Supplier Co.</div>
        <hr className="ob-paper-rule" />
        <div className="ob-paper-row">
          <span>2 × Sample Widget</span>
          <b>$1,000.00</b>
        </div>
        <div className="ob-paper-row">
          <span>Freight</span>
          <b>$100.00</b>
        </div>
        <div className="ob-paper-row" data-signal="true">
          <span>Landed cost per unit</span>
          <b>$550.00</b>
        </div>
      </div>
      <div className="ob-paper" style={{ maxWidth: 260, justifySelf: "start", marginLeft: 40, display: "flex", alignItems: "center", gap: 12, padding: "14px 18px" }}>
        <IconCircleCheckFilled size={26} color="#7d8a22" />
        <div>
          <div style={{ fontWeight: 650 }}>Paid in full</div>
          <div className="ob-paper-muted">$1,100.00 · books balanced</div>
        </div>
      </div>
    </>
  );
}

/** The company's letterhead, as it will print on a receipt. */
export function CompanyStage({ name, address, homeState, fiscalMonth }: { name: string; address: string; homeState: string; fiscalMonth: number }) {
  const start = MONTHS[fiscalMonth - 1];
  const end = MONTHS[(fiscalMonth + 10) % 12];
  return (
    <div className="ob-paper" style={{ padding: "28px 28px 24px" }}>
      <div className="ob-paper-label">Warehouse receipt</div>
      <div className="ob-paper-title" data-empty={name.trim() ? undefined : "true"} style={{ fontSize: 26 }}>
        {name.trim() || "Your company"}
      </div>
      <div className="ob-paper-muted" style={{ marginTop: 6, minHeight: 21 }}>
        {address.trim() || " "}
      </div>
      <hr className="ob-paper-rule" />
      <div className="ob-paper-row">
        <span>Number</span>
        <b className="ob-code">WH-IN-00001</b>
      </div>
      <div className="ob-paper-row">
        <span>Home state</span>
        <b>{homeState || "—"}</b>
      </div>
      <div className="ob-paper-row">
        <span>Fiscal year</span>
        <b>
          {start} – {end}
        </b>
      </div>
    </div>
  );
}

export type Person = { name: string; job: Job; you?: boolean };

/** "Who's working?" on a phone, filling in as people are added. */
export function TeamStage({ people }: { people: Person[] }) {
  const ghosts = Math.max(0, 4 - people.length);
  return (
    <div className="ob-device">
      <div className="ob-device-screen">
        <div className="ob-device-title">Who's working?</div>
        <div className="ob-device-grid">
          {people.slice(0, 6).map((person) => (
            <div key={person.name} className="ob-device-tile">
              <Avatar name={person.name} size={44} you={person.you} />
              <b>{person.name}</b>
              <small>{person.you ? "You" : JOB_LABEL[person.job]}</small>
            </div>
          ))}
          {Array.from({ length: ghosts }, (_, i) => (
            <div key={i} className="ob-device-tile" data-ghost="true" />
          ))}
        </div>
      </div>
    </div>
  );
}

type Sample = { supplier: { name: string }; carrier: { name: string }; widget: { sku: string; barcode: string }; robot: { sku: string; barcode: string }; openBox: { sku: string } };

/** What each way of starting gives you. */
export function StartStage({ mode, sample }: { mode: "sample" | "empty"; sample: Sample }) {
  if (mode === "empty") {
    return (
      <>
        {["Your warehouse", "The vendors you buy from", "The items you stock"].map((line) => (
          <div key={line} className="ob-ghost">
            {line}
          </div>
        ))}
      </>
    );
  }
  return (
    <div className="ob-paper">
      <div className="ob-paper-label">In the sample</div>
      <hr className="ob-paper-rule" />
      <div className="ob-paper-row">
        <span>Warehouse</span>
        <b>MAIN · Main warehouse</b>
      </div>
      <div className="ob-paper-row">
        <span>Supplier</span>
        <b>{sample.supplier.name}</b>
      </div>
      <div className="ob-paper-row">
        <span>Freight carrier</span>
        <b>{sample.carrier.name}</b>
      </div>
      <hr className="ob-paper-rule" style={{ borderTopColor: "#e6e7e1" }} />
      {[
        { sku: sample.widget.sku, tag: "Counted" },
        { sku: sample.robot.sku, tag: "Serial per unit" },
        { sku: sample.openBox.sku, tag: "Open box" },
      ].map((item) => (
        <div key={item.sku} className="ob-paper-row" style={{ alignItems: "center" }}>
          <b className="ob-code">{item.sku}</b>
          <span className="ob-tag">{item.tag}</span>
        </div>
      ))}
      <div className="ob-paper-muted" style={{ marginTop: 10 }}>
        Plus a printable test sheet of barcodes and a packing slip.
      </div>
    </div>
  );
}

/** A shelf label for the warehouse being named. */
export function WarehouseStage({ code, name, more }: { code: string; name: string; more: number }) {
  return (
    <>
      <div className="ob-paper" style={{ maxWidth: 340, padding: "26px 26px 22px" }}>
        <div className="ob-paper-label">Location</div>
        <div className="ob-paper-title" data-empty={code ? undefined : "true"} style={{ fontSize: 44, letterSpacing: "0.02em" }}>
          {code || "MAIN"}
        </div>
        <div className="ob-paper-muted">{name || "Main warehouse"}</div>
        <div className="ob-bars" style={{ marginTop: 16 }} />
      </div>
      {more > 0 ? <div className="ob-ghost" style={{ maxWidth: 340, textAlign: "center" }}>+ {more} more</div> : null}
    </>
  );
}

/** Vendor cards, the newest on top. */
export function VendorsStage({ vendors }: { vendors: { name: string; kind: string; paymentTermsDays: number }[] }) {
  if (!vendors.length) return <div className="ob-ghost">Suppliers you buy stock from, and carriers who bill you for freight, appear here.</div>;
  return (
    <>
      {vendors.slice(-3).reverse().map((vendor) => (
        <div key={vendor.name} className="ob-paper" style={{ maxWidth: 360, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{vendor.name}</div>
            <div className="ob-paper-muted">{vendor.kind === "CARRIER" ? "Freight carrier" : "Supplier"}</div>
          </div>
          <span className="ob-tag">Net {vendor.paymentTermsDays}</span>
        </div>
      ))}
    </>
  );
}

/** The item's label as the dock camera will see it. */
export function ItemsStage({ sku, name, barcode, serial, costCents, count }: { sku: string; name: string; barcode: string; serial: boolean; costCents: number; count: number }) {
  return (
    <>
      <div className="ob-paper" style={{ maxWidth: 360, padding: "24px 24px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div className="ob-paper-label">Item</div>
          {serial ? <span className="ob-tag">Serial per unit</span> : null}
        </div>
        <div className="ob-paper-title" data-empty={sku ? undefined : "true"}>
          {sku || "SKU"}
        </div>
        <div className="ob-paper-muted">{name || "What it's called"}</div>
        <div className="ob-bars" style={{ marginTop: 16 }} />
        <div className="ob-code" style={{ textAlign: "center", marginTop: 6, color: barcode ? "#111210" : "#b0b4a4" }}>
          {barcode || "barcode"}
        </div>
        <hr className="ob-paper-rule" style={{ borderTopColor: "#e6e7e1" }} />
        <div className="ob-paper-row">
          <span>Usual cost</span>
          <b>{usd(costCents)}</b>
        </div>
      </div>
      {count > 0 ? <div className="ob-ghost" style={{ maxWidth: 360, textAlign: "center" }}>{count} in your catalog</div> : null}
    </>
  );
}

/** Opening stock as the journal entry it will post. */
export function OpeningStage({ totalCents }: { totalCents: number }) {
  return (
    <div className="ob-paper" style={{ maxWidth: 380 }}>
      <div className="ob-paper-label">Opening stock</div>
      <div className="ob-paper-title" style={{ fontSize: 34 }}>
        {usd(totalCents)}
      </div>
      <hr className="ob-paper-rule" />
      <div className="ob-paper-row">
        <span>Dr Inventory Asset</span>
        <b>{usd(totalCents)}</b>
      </div>
      <div className="ob-paper-row">
        <span>Cr Opening balance equity</span>
        <b>{usd(totalCents)}</b>
      </div>
    </div>
  );
}

const reduceMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The finish: the printer feeds out a receipt for the company just set up. */
export function SetupReceipt({ company, rows, sample }: { company: string; rows: [string, string][]; sample: boolean }) {
  const [stage, setStage] = useState<PrinterStage>(() => (reduceMotion() ? "complete" : "processing"));
  useEffect(() => {
    if (stage === "complete") return;
    const toPrinting = window.setTimeout(() => setStage("printing"), 650);
    const toComplete = window.setTimeout(() => setStage("complete"), 650 + 1800);
    return () => {
      window.clearTimeout(toPrinting);
      window.clearTimeout(toComplete);
    };
  }, []);
  const status = { processing: "Finishing setup", printing: "Printing", complete: "Ready to receive" }[stage];
  return (
    <ReceiptPrinter stage={stage} status={status}>
      <div className="receipt-head">
        <b>{company.toUpperCase()}</b>
        SETUP COMPLETE
        <br />
        {new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
      </div>
      <hr className="receipt-rule" />
      {rows.map(([label, value]) => (
        <div key={label} className="ob-receipt-row">
          <span>{label}</span>
          <b>{value}</b>
        </div>
      ))}
      <hr className="receipt-rule" />
      <div className="receipt-total">
        <span>{sample ? "SAMPLE DATA" : "YOUR DATA"}</span>
        <b>READY</b>
      </div>
    </ReceiptPrinter>
  );
}
