import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "AI Drama Studio",
  description: "文本创作工作台",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
