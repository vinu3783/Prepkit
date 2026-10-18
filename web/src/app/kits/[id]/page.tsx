"use client";

import { useParams } from "next/navigation";
import { RequireAuth } from "@/components/AuthProvider";
import { KitScreen } from "@/components/kit/KitScreen";

export default function KitPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <RequireAuth>
      <KitScreen id={id} />
    </RequireAuth>
  );
}
