"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import CalendarSkeleton from "@/components/calendarComp/CalendarSkeleton";
import RequirePermission from "@/components/ui/RequirePermission";

// The calendar owns its own data now: it is the only component that knows which
// date range is on screen, and every read is bounded to that range.
const Calendar = dynamic(() => import("@/components/calendarComp/Calendar"), {
  ssr: false,
  loading: () => <CalendarSkeleton />,
});

export default function CalendarPage() {
  const params = useParams();
  const id = Array.isArray(params?.lawFirmId) ? params.lawFirmId[0] : (params?.lawFirmId as string | undefined);

  if (!id) return <p>Missing law firm id.</p>;

  return (
    <RequirePermission permission="calendar.view" page>
      <div className="h-screen bg-page flex flex-col overflow-hidden">
        <div className="flex-1 min-h-0">
          <Calendar embedded />
        </div>
      </div>
    </RequirePermission>
  );
}
