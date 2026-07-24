import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zeus MMO",
  description: "Control plane cho video production, dịch, file và VPS render",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
