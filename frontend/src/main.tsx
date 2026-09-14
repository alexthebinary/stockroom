import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider } from "./auth";

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
      defaultColorScheme="light"
      theme={{
        primaryColor: "indigo",
        // indigo-6 gives white-on-primary 4.32:1, just under the 4.5:1 needed.
        // indigo-7 measures 4.98:1.
        primaryShade: { light: 7, dark: 8 },
        // Mantine writes its own font stack onto `body`, which outranks any
        // rule inherited from :root — so the system face has to be set here or
        // it silently does not apply.
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        // Pure black is harsher than any platform uses for label text. This is
        // the rail navy taken to near-black, so the chrome and the copy belong
        // to one family.
        black: "#0b1b30",
        defaultRadius: "md",
        headings: {
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
          fontWeight: "650",
          // Optical sizing: the larger the face, the tighter it wants to be set.
          sizes: {
            h1: { fontSize: "30px", lineHeight: "1.2" },
            h2: { fontSize: "22px", lineHeight: "1.25" },
            h3: { fontSize: "17px", lineHeight: "1.3" },
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
