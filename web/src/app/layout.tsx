import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "YTB VPS Studio",
  description: "Điều phối video với GPU VPS thuê theo giờ",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
