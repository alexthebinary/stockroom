import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";

/**
 * A physical key: a shaped face on a firm edge that travels down when pressed.
 * Adapted from dqnamo's Kitchen (see README.md). `tone="ink"` is the black
 * pill of the design system; `tone="signal"` is the one lime action on a
 * screen (finish, go).
 */
type Shared = { children: ReactNode; tone?: "ink" | "signal"; size?: "lg" | "xl"; fullWidth?: boolean; className?: string };

type AsButton = Shared & Omit<ComponentPropsWithoutRef<"button">, keyof Shared> & { to?: never };
type AsLink = Shared & Omit<LinkProps, keyof Shared>;

export function TactileButton(props: AsButton | AsLink) {
  const { children, tone = "ink", size = "lg", fullWidth, className, ...rest } = props;
  const classes = ["tactile", `tactile-${tone}`, `tactile-${size}`, fullWidth ? "tactile-full" : "", className ?? ""].join(" ");
  const layers = (
    <>
      <span className="tactile-base" aria-hidden="true" />
      <span className="tactile-face">{children}</span>
    </>
  );
  if ("to" in rest && rest.to !== undefined) {
    return (
      <Link className={classes} {...(rest as LinkProps)}>
        {layers}
      </Link>
    );
  }
  const { type = "button", ...buttonProps } = rest as ComponentPropsWithoutRef<"button">;
  return (
    <button className={classes} type={type} {...buttonProps}>
      {layers}
    </button>
  );
}
