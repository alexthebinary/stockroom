import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { type Profile, setUnauthorizedHandler, storedProfile, storeProfile } from "./api";

type ProfileState = { profile: Profile | null; choose: (p: Profile | null) => void };
const ProfileContext = createContext<ProfileState>({ profile: null, choose: () => {} });

/** "Who's working" on this device. No sign-in (by decision): it picks the home screen and signs their work. */
export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(() => storedProfile());
  const choose = (p: Profile | null) => {
    storeProfile(p);
    setProfile(p);
  };
  useEffect(() => setUnauthorizedHandler(() => choose(null)), []);
  return <ProfileContext.Provider value={{ profile, choose }}>{children}</ProfileContext.Provider>;
}

export const useProfile = () => useContext(ProfileContext);

export const JOB_LABEL = { CLERK: "Warehouse", ACCOUNTING: "Accounting", ADMIN: "Admin" } as const;
