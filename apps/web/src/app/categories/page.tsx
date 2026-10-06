import type { Metadata } from "next";
import { CategoryCenter } from "../../components/category-center";
import { CreatorShell } from "../../components/creator-shell";

export const metadata: Metadata = { title: "短剧分类中心 · AI Drama Studio", description: "探索短剧题材、故事标签，整理你的创作方向。" };

export default function CategoriesPage() {
  return <CreatorShell appearance="light" activePath="/categories"><CategoryCenter /></CreatorShell>;
}
