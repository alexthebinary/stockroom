import { Center, Loader } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Shell } from "./components/Shell";
import { BillDesk } from "./features/bills/BillDesk";
import { BillPage, NewFreightBill } from "./features/bills/BillPage";
import { Guide } from "./features/home/Guide";
import { HomePage } from "./features/home/Homes";
import { ProfilePicker } from "./features/home/ProfilePicker";
import { NewOrder, OrderDetail, Orders } from "./features/orders/Orders";
import { Payables } from "./features/payables/Payables";
import { ReceiveWizard } from "./features/receive/ReceiveWizard";
import { Reports } from "./features/reports/Reports";
import { Practice } from "./features/scan/Practice";
import { Items } from "./features/settings/Items";
import { Settings } from "./features/settings/Settings";
import { SetupWizard } from "./features/setup/SetupWizard";
import { TestSheet } from "./features/setup/TestSheet";
import { get } from "./lib/api";
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
  if (pathname === "/test-sheet") return <TestSheet />;
  if (setup.data.required || pathname === "/setup") return <SetupWizard />;
  if (!profile) return <ProfilePicker />;
  return (
    <Shell>
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
