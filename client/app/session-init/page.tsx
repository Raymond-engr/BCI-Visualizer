import { Suspense } from "react";

import { SessionInitScreen } from "@/components/bci/screens/SessionInitScreen";

export default function SessionInitPage() {
  return (
    <Suspense>
      <SessionInitScreen />
    </Suspense>
  );
}
