import { DashboardShell } from "@/components/dashboard-shell";
import { LoginForm } from "@/components/login-form";
import { currentAdmin } from "@/lib/auth/current-admin";
import { parseServerEnv } from "@/lib/config/env";
import { createNeonControlPlaneRepository } from "@/lib/repositories/neon-control-plane";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const env = parseServerEnv(process.env);
  if (!(await currentAdmin(env.sessionSecret))) {
    return (
      <main className="page-shell">
        <LoginForm />
      </main>
    );
  }

  const jobs = await createNeonControlPlaneRepository(env.databaseUrl).listJobs();
  return <DashboardShell workerOnline={false} jobs={jobs} />;
}
