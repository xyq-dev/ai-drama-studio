import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "AI Drama Studio",
  description: "面向独立创作者的 AI 短剧创作预览",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
