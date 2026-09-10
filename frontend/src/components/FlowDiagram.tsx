/**
 * The three lifecycles, drawn rather than described.
 *
 * Inline SVG on purpose: a diagram library would be a dependency for two
 * static pictures, and hand-drawn boxes let the ledger postings sit directly
 * under the step that causes them, which is the whole point of showing this.
 */

type Step = {
  label: string;
  posting?: string;
  stock?: string;
};

function Lane({
  title,
  steps,
  accent,
}: {
  title: string;
  steps: Step[];
  accent: string;
}) {
  const boxW = 132;
  const gap = 30;
  const rowH = 96;
  const width = steps.length * boxW + (steps.length - 1) * gap;

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${width} ${rowH + 46}`}
        style={{ width: "100%", minWidth: width, height: "auto" }}
        role="img"
        aria-label={`${title}: ${steps.map((s) => s.label).join(" then ")}`}
      >
        <text x={0} y={14} fontSize={12} fontWeight={700} fill="var(--mantine-color-gray-7)">
          {title}
        </text>
        {steps.map((step, i) => {
          const x = i * (boxW + gap);
          const y = 26;
          return (
            <g key={step.label}>
              <rect
                x={x}
                y={y}
                width={boxW}
                height={34}
                rx={5}
                fill={`var(--mantine-color-${accent}-0)`}
                stroke={`var(--mantine-color-${accent}-4)`}
              />
              <text
                x={x + boxW / 2}
                y={y + 22}
                fontSize={12.5}
                fontWeight={600}
                textAnchor="middle"
                fill={`var(--mantine-color-${accent}-9)`}
              >
                {step.label}
              </text>

              {step.stock && (
                <text x={x} y={y + 52} fontSize={10.5} fill="var(--mantine-color-gray-7)">
                  {step.stock}
                </text>
              )}
              {step.posting && (
                <text x={x} y={y + 52 + (step.stock ? 14 : 0)} fontSize={10.5} fill="var(--mantine-color-indigo-7)">
                  {step.posting}
                </text>
              )}

              {i < steps.length - 1 && (
                <g stroke="var(--mantine-color-gray-5)" strokeWidth={1.5}>
                  <line x1={x + boxW + 6} y1={y + 17} x2={x + boxW + gap - 9} y2={y + 17} />
                  <path
                    d={`M ${x + boxW + gap - 9} ${y + 17} l -5 -3.5 l 0 7 z`}
                    fill="var(--mantine-color-gray-5)"
                    stroke="none"
                  />
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function SalesFlow() {
  return (
    <>
      {/*
        Two rows, not one. The axes are independent: an order can be invoiced
        while still unpacked, and can ship before it is paid. Drawing them as a
        single sequence would assert an ordering the API does not enforce.
      */}
      <Lane
        title="SALES ORDER · FULFILMENT"
        accent="blue"
        steps={[
          { label: "Not packed", stock: "nothing reserved" },
          { label: "Packed", stock: "reserved ↑ available ↓" },
          { label: "Shipped", stock: "on hand ↓ reserved ↓", posting: "Dr COGS / Cr Inventory" },
        ]}
      />
      <div style={{ height: 14 }} />
      <Lane
        title="SALES ORDER · BILLING (independent of fulfilment)"
        accent="cyan"
        steps={[
          { label: "Awaiting payment" },
          { label: "Invoiced", posting: "Dr Receivable / Cr Revenue" },
          { label: "Paid", posting: "Dr Bank / Cr Receivable" },
        ]}
      />
    </>
  );
}

export function PurchaseFlow() {
  return (
    <Lane
      title="PURCHASE ORDER · paying and receiving are interchangeable"
      accent="teal"
      steps={[
        { label: "Saved", stock: "incoming ↑" },
        { label: "Posted", posting: "Dr Prepaid / Cr Payable" },
        // A vendor may deliver before invoicing, so /pay accepts a DELIVERED
        // order too — the last two steps can happen in either order.
        { label: "Paid", posting: "Dr Payable / Cr Bank" },
        {
          label: "Delivered",
          stock: "incoming ↓ on hand ↑",
          posting: "Dr Inventory + variance / Cr Prepaid",
        },
      ]}
    />
  );
}

export function TransferFlow() {
  return (
    <Lane
      title="STOCK TRANSFER"
      accent="grape"
      steps={[
        { label: "Draft", stock: "nothing moved" },
        {
          label: "In transit",
          stock: "source on hand ↓, layers consumed",
          // The one journal entry a transfer makes happens here, moving the
          // carrying cost between warehouses within the Inventory account.
          posting: "Dr Inventory / Cr Inventory",
        },
        {
          label: "Completed",
          stock: "destination on hand ↑, layers rebuilt at original cost and age",
          // Deliberately no posting: the cost already moved at dispatch.
        },
      ]}
    />
  );
}
