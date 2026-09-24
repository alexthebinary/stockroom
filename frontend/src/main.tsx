import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth";

import "@fontsource-variable/funnel-sans";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./theme.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider
      // "auto" follows the OS until someone chooses. Mantine resolves it and
      // writes data-mantine-color-scheme onto <html>, which is what theme.css
      // keys its dark tokens off — one source of truth, so the toggle and the
      // system preference cannot disagree.
      defaultColorScheme="auto"
      theme={{
        // Machine-shop precision (DESIGN.md): black ink, near-white plate, one
        // lime signal. `ink` is the primary: black pill in light, the plate
        // colour inverted in dark. Shade 7 is the light fill and 8 the dark
        // fill (primaryShade below); the ramp is otherwise ordered.
        colors: {
          ink: ["#f4f5f0", "#e6e8df", "#cfd2c5", "#b0b4a4", "#8f9384", "#6f7366", "#51554a", "#111210", "#eeefe9", "#d9dbd3"],
          // "teal" is the app's passing / done colour at 20 call sites. Rather
          // than a second green, it becomes the signal's dark olive, so every
          // passing state reads as the same family as the lime.
          teal: ["#f7f9e6", "#eef3cc", "#e0e9a3", "#d3df7c", "#c6d55a", "#a9b83e", "#7d8a22", "#55620f", "#c6d55a", "#3a440a"],
          // Mantine paints dark-mode cards, inputs and borders from `dark`; its
          // default is a warm #2e2e2e that fights the plate. Same family here.
          dark: ["#d9dbd3", "#b0b3a8", "#8f9387", "#6d7066", "#3a3d36", "#2a2c27", "#181a16", "#121311", "#0c0d0b", "#080907"],
          // "blue" marks in-transit / neutral info: a cool steel, not a brand hue.
          blue: ["#eef1f4", "#dce2e8", "#b9c4cf", "#94a4b3", "#71869a", "#5a6f83", "#465a6d", "#344657", "#9fb2c4", "#1f2c38"],
        },
        primaryColor: "ink",
        primaryShade: { light: 7, dark: 8 },
        autoContrast: true,
        // Mantine writes its own font stack onto `body`, which outranks any
        // rule inherited from :root — so the face has to be set here or it
        // silently does not apply.
        fontFamily: '"Funnel Sans Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
        fontFamilyMonospace: 'ui-monospace, "SF Mono", Menlo, monospace',
        black: "#111210",
        white: "#fafaf7",
        defaultRadius: "md",
        radius: { xs: "4px", sm: "6px", md: "12px", lg: "16px", xl: "999px" },
        components: {
          // Actions are pills; everything that holds data is a plate.
          Button: { defaultProps: { radius: "xl" } },
        },
        headings: {
          fontFamily: '"Funnel Sans Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
          fontWeight: "600",
          sizes: {
            h1: { fontSize: "32px", lineHeight: "1.1" },
            h2: { fontSize: "24px", lineHeight: "1.15" },
            h3: { fontSize: "18px", lineHeight: "1.25" },
            h4: { fontSize: "15px", lineHeight: "1.35" },
          },
        },
      }}
    >
      <Notifications position="top-right" />
      <ModalsProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </AuthProvider>
        </QueryClientProvider>
      </ModalsProvider>
    </MantineProvider>
  </React.StrictMode>
);
