import { cookies } from "next/headers";
import { verifySession } from "./session";

export const ADMIN_COOKIE = "ytb_admin_session";

export async function currentAdmin(sessionSecret: string): Promise<boolean> {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  return token ? verifySession(token, sessionSecret) !== null : false;
}
