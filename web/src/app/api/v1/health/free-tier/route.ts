import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    {
      service: "ytb-vps-control-plane",
      mode: "READ_ONLY",
      reasons: ["DRIVE_NOT_CONNECTED"],
    },
    { headers: { "cache-control": "no-store" } },
  );
}
