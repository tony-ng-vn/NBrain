import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NBrain",
  description: "Demo-first repo knowledge hub with Notion-backed claims.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
