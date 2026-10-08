import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { type Profile, setUnauthorizedHandler, storedProfile, storeProfile } from "./api";

type ProfileState = { profile: Profile | null; choose: (p: Profile | null) => void };
const ProfileContext = createContext<ProfileState>({ profile: null, choose: () => {} });

/** "Who's working" on this device. No sign-in (by decision): it picks the home screen and signs their work. */
export function ProfileProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [profile, setProfile] = useState<Profile | null>(() => storedProfile());
  const choose = (p: Profile | null) => {
    storeProfile(p);
    // A shared device changing hands: the next person never sees the last one's
    // cached screens. The company's setup state is not personal, so it stays.
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "setup" });
    setProfile(p);
  };
  useEffect(() => setUnauthorizedHandler(() => choose(null)), []);
  return <ProfileContext.Provider value={{ profile, choose }}>{children}</ProfileContext.Provider>;
}

export const useProfile = () => useContext(ProfileContext);

export const JOB_LABEL = { CLERK: "Warehouse", ACCOUNTING: "Accounting", ADMIN: "Admin" } as const;
