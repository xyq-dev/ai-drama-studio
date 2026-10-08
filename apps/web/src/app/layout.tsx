import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "红果创作 · 把故事，做成短剧",
  description: "面向独立创作者的 AI 短剧创作预览",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
