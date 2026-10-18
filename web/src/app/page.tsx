"use client";

import { useRef } from "react";
import { RequireAuth } from "@/components/AuthProvider";
import { KitList, type KitListHandle } from "@/components/KitList";
import { NewKitForm } from "@/components/NewKitForm";

export default function DashboardPage() {
  const list = useRef<KitListHandle>(null);
  return (
    <RequireAuth>
      <div className="flex flex-col gap-8">
        <NewKitForm onCreated={() => list.current?.refresh()} />
        <section aria-labelledby="your-kits">
          <h2 id="your-kits" className="mb-3 text-lg font-semibold">
            Your kits
          </h2>
          <KitList ref={list} />
        </section>
      </div>
    </RequireAuth>
  );
}
