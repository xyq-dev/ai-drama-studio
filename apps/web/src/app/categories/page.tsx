import type { Metadata } from "next";
import { CategoryCenter } from "../../components/category-center";
import { CreatorShell } from "../../components/creator-shell";

export const metadata: Metadata = { title: "灵感中心 · 红果创作", description: "探索短剧题材、故事标签，整理你的创作方向。" };

export default function CategoriesPage() {
  return <CreatorShell activePath="/categories"><CategoryCenter /></CreatorShell>;
}
