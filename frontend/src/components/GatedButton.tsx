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

  return (
    <Tooltip label={reason} events={{ hover: true, focus: true, touch: false }} withArrow>
      <Button {...props} data-disabled onClick={(event) => event.preventDefault()}>
        {children}
      </Button>
    </Tooltip>
  );
}
