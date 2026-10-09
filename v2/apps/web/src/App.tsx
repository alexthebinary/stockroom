import { Center, Loader } from "@mantine/core";
import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Shell } from "./components/Shell";
import { BillDesk } from "./features/bills/BillDesk";
import { BillPage, NewFreightBill } from "./features/bills/BillPage";
import { FeedbackLayer } from "./features/feedback/FeedbackLayer";
import { FeedbackPage } from "./features/feedback/FeedbackPage";
import { Guide } from "./features/home/Guide";
import { HomePage } from "./features/home/Homes";
import { ProfilePicker } from "./features/home/ProfilePicker";
import { NewOrder, OrderDetail, Orders } from "./features/orders/Orders";
import { Payables } from "./features/payables/Payables";
import { ReceiveWizard } from "./features/receive/ReceiveWizard";
import { Items } from "./features/settings/Items";
import { get } from "./lib/api";

// Screens a clerk's phone rarely or never opens load on demand.
const Reports = lazy(() => import("./features/reports/Reports").then((m) => ({ default: m.Reports })));
const Practice = lazy(() => import("./features/scan/Practice").then((m) => ({ default: m.Practice })));
const Settings = lazy(() => import("./features/settings/Settings").then((m) => ({ default: m.Settings })));
const SetupWizard = lazy(() => import("./features/setup/SetupWizard").then((m) => ({ default: m.SetupWizard })));
const TestSheet = lazy(() => import("./features/setup/TestSheet").then((m) => ({ default: m.TestSheet })));

const spinner = (
  <Center h="60dvh">
    <Loader />
  </Center>
);
import { useProfile } from "./lib/profile";
import type { Setup } from "./lib/types";

/**
 * Fresh install → the setup wizard. Then "who's working?" on each device.
 * Then the home screen for that person's job.
 */
export function App() {
  const { profile } = useProfile();
  const { pathname } = useLocation();
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => get<Setup>("/setup") });
  if (!setup.data) {
    return (
      <Center h="100dvh">
        <Loader />
      </Center>
    );
  }
  return (
    <>
      <Screens profile={profile != null} required={setup.data.required} pathname={pathname} />
      <FeedbackLayer />
    </>
  );
}

function Screens({ profile, required, pathname }: { profile: boolean; required: boolean; pathname: string }) {
  if (pathname === "/test-sheet") return <Suspense fallback={spinner}><TestSheet /></Suspense>;
  if (required || pathname === "/setup") return <Suspense fallback={spinner}><SetupWizard /></Suspense>;
  if (!profile) return <ProfilePicker />;
  return (
    <Shell>
      <Suspense fallback={spinner}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/receive" element={<ReceiveWizard />} />
        <Route path="/receive/practice" element={<Practice />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/new" element={<NewOrder />} />
        <Route path="/orders/:id" element={<OrderDetail />} />
        <Route path="/bills" element={<BillDesk />} />
        <Route path="/bills/freight/new" element={<NewFreightBill />} />
        <Route path="/bills/:id" element={<BillPage />} />
        <Route path="/payables" element={<Payables />} />
        <Route path="/items" element={<Items />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/guide" element={<Guide />} />
        <Route path="/feedback" element={<FeedbackPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </Shell>
  );
}
