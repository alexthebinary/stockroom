import { createTheme, type CSSVariablesResolver, defaultVariantColorsResolver, type MantineColorsTuple, parseThemeColor, type VariantColorsResolver } from "@mantine/core";

/**
 * ProfitIndex's "machine-shop precision" look, carried over from v1: a
 * near-white plate, black ink, black pill actions, and one acid-lime signal
 * kept for go / done / selected. Both palettes run light → dark in order, so
 * Mantine's derived hover (the next shade) is always a small, sane step —
 * v1's non-monotonic ramps made the black pill hover to near-white.
 */
const ink: MantineColorsTuple = ["#f4f5f0", "#e6e8df", "#cfd2c5", "#b0b4a4", "#8f9384", "#6f7366", "#51554a", "#33362f", "#1e201c", "#111210"];
const lime: MantineColorsTuple = ["#f7f9e6", "#eef3cc", "#e0e9a3", "#d3df7c", "#c6d55a", "#a9b83e", "#7d8a22", "#55620f", "#3f4a0e", "#2c340a"];

/**
 * The ink pill flips with the scheme (black on light, near-white on dark), but
 * Mantine works out a filled button's text colour once, from the light shade,
 * so dark mode got white text on a white pill. The plate colour is always the
 * opposite of the ink, so it is the text colour in both.
 */
const variantColorResolver: VariantColorsResolver = (input) => {
  const colors = defaultVariantColorsResolver(input);
  const parsed = parseThemeColor({ color: input.color ?? input.theme.primaryColor, theme: input.theme });
  if (input.variant === "filled" && parsed.isThemeColor && parsed.color === "ink" && parsed.shade === undefined) {
    return { ...colors, color: "var(--surface)", hoverColor: "var(--surface)" };
  }
  return colors;
};

export const theme = createTheme({
  variantColorResolver,
  primaryColor: "ink",
  primaryShade: { light: 9, dark: 1 },
  autoContrast: true,
  colors: { ink, lime },
  fontFamily: "'Funnel Sans Variable', system-ui, -apple-system, sans-serif",
  headings: { fontWeight: "600", sizes: { h1: { fontSize: "28px" }, h2: { fontSize: "22px" }, h3: { fontSize: "18px" } } },
  defaultRadius: "md",
  cursorType: "pointer",
  components: {
    Button: { defaultProps: { radius: "xl" } },
    ActionIcon: { defaultProps: { radius: "xl" } },
    Badge: { defaultProps: { radius: "sm", variant: "light" } },
    Anchor: { defaultProps: { c: "var(--text-strong)", underline: "always" } },
    Progress: { defaultProps: { color: "lime.4" } },
  },
});

/** Disabled controls in the warm neutrals, not Mantine's default blue-grays. */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: { "--mantine-color-disabled": "#ecede6", "--mantine-color-disabled-color": "#9a9d90", "--mantine-color-disabled-border": "#dcded6" },
  dark: { "--mantine-color-disabled": "#22241f", "--mantine-color-disabled-color": "#6f7366", "--mantine-color-disabled-border": "#2a2c27" },
});
