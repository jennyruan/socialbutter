import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ButterSocial — events worth your time",
  description:
    "Agent that picks the events worth a busy professional's time. Connects to your Luma calendar and learns from your past feedback.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
