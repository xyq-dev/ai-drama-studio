import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "AI Drama Studio",
  description: "M1-A platform skeleton status",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
