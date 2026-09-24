import { Button, Tooltip, type ButtonProps } from "@mantine/core";

/**
 * A button that explains why it cannot be used.
 *
 * Mantine's `disabled` sets the native attribute, which drops the control out
 * of the tab order and stops a tooltip from ever firing — so a keyboard user
 * cannot even find out why an action is unavailable. `data-disabled` keeps the
 * button focusable and styled as disabled, and the click is swallowed instead.
 */
export function GatedButton({
  reason,
  children,
  onClick,
  ...props
}: ButtonProps & {
  reason?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  if (!reason) {
    return (
      <Button {...props} onClick={onClick}>
        {children}
      </Button>
    );
  }

  // Unavailable must LOOK unavailable: a `light` button kept its coloured text
  // under data-disabled and read as live (critique 2026-09-24). And the reason
  // must reach touch screens, where there is no hover — a tap shows it.
  return (
    <Tooltip label={reason} events={{ hover: true, focus: true, touch: true }} withArrow multiline maw={260}>
      <Button
        {...props}
        variant="default"
        color="gray"
        c="dimmed"
        data-disabled
        onClick={(event) => event.preventDefault()}
      >
        {children}
      </Button>
    </Tooltip>
  );
}
