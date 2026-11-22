import { AiModelVendorSettings } from "../../../../components/ai-model-vendors";

export const metadata = { title: "供应商设置 · 红果运营后台" };

export default async function AdminAiModelVendorPage({
  params,
}: {
  params: Promise<{ vendor: string }>;
}) {
  const { vendor } = await params;
  return <AiModelVendorSettings vendorId={vendor} />;
}
