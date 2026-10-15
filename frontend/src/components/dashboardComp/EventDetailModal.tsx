"use client";

import { useEffect, useState } from "react";
import { X, CalendarClock, CalendarDays, Briefcase, UserRound, MapPin, Tag } from "lucide-react";
import Modal from "@/components/ui/Modal";
import { useNavigation } from "@/contexts/NavigationContext";
import Button from "@/components/ui/Button";
import { matterEventTypeMeta, styleOf } from "@/constants/statusMeta";
import type { CalendarWidgetEvent } from "./DashboardCalendarWidget";
import SectionLabel from "@/components/ui/SectionLabel";
import { formatEventWhen } from "@/components/calendarComp/calendarTiming";

interface EventDetailModalProps {
  event: CalendarWidgetEvent | null;
  open: boolean;
  onClose: () => void;
  lawFirmId: string;
}

export default function EventDetailModal({ event, open, onClose, lawFirmId }: EventDetailModalProps) {
  const { navigate } = useNavigation();

  // Retain the last non-null event so the content does not blank out while the
  // exit animation plays (the parent clears `event` the moment it closes).
  const [shown, setShown] = useState<CalendarWidgetEvent | null>(event);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- retains the last non-null event so content doesn't blank during the exit animation
    if (event) setShown(event);
  }, [event]);

  if (!shown) return null;

  const goToMatter = () => {
    if (!shown.matterId) return;
    onClose();
    navigate(`/lawfirm/${lawFirmId}/matters/${shown.matterId}`);
  };

  const goToCalendar = () => {
    onClose();
    navigate(`/lawfirm/${lawFirmId}/calendar`);
  };

  const typeLabel = shown.type
    ? matterEventTypeMeta(shown.type).label
    : shown.source === "matter"
      ? "Matter event"
      : "Client event";
  const typeStyle = styleOf(matterEventTypeMeta(shown.type));
  // An untimed event is read off its calendar day, never the stored instant,
  // which falls on another day in a zone far enough from UTC.
  const when = formatEventWhen({
    id: shown.id,
    title: shown.title,
    start: shown.hasTime ? shown.iso : shown.dayKey,
    end: shown.end ?? undefined,
    allDay: !shown.hasTime,
    startLocalDisplay: shown.startLocalDisplay,
    endLocalDisplay: shown.endLocalDisplay,
  });
  const context = shown.source === "matter" ? shown.matterName : shown.clientName;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      labelledBy="event-detail-title"
      showClose={false}
      className="relative"
      bodyClassName={null}
    >
      <div className="flex items-start justify-between px-6 py-4 border-b border-outline shrink-0">
        <div className="min-w-0">
          <SectionLabel tone="secondary" gap="1">Event</SectionLabel>
          <h2 id="event-detail-title" className="text-lg font-semibold text-on-surface">{shown.title}</h2>
        </div>
        <button
          onClick={onClose}
          className="text-on-surface-muted hover:text-on-surface transition-colors shrink-0 ml-3 cursor-pointer"
          aria-label="Close"
        >
          <X size={18} />
        </button>
      </div>

      <div className="px-6 py-5 space-y-5 overflow-y-auto overflow-x-hidden styled-scrollbar">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${typeStyle.tint} ${typeStyle.text}`}>
            {typeLabel}
          </span>
          <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-surface-alt text-on-surface-secondary border border-outline-subtle">
            {shown.source === "matter" ? "Matter" : "Client"}
          </span>
        </div>

        <dl className="space-y-3">
          <div className="flex items-start justify-between gap-4 text-sm">
            <dt className="flex items-center gap-2 text-on-surface-secondary shrink-0">
              <CalendarClock size={15} /> When
            </dt>
            <dd className="text-on-surface font-medium text-right">{when}</dd>
          </div>
          <div className="flex items-start justify-between gap-4 text-sm">
            <dt className="flex items-center gap-2 text-on-surface-secondary shrink-0">
              <Tag size={15} /> Type
            </dt>
            <dd className="text-on-surface font-medium text-right">{typeLabel}</dd>
          </div>
          {shown.source === "matter" && (
            <div className="flex items-start justify-between gap-4 text-sm">
              <dt className="flex items-center gap-2 text-on-surface-secondary shrink-0">
                <Briefcase size={15} /> Matter
              </dt>
              <dd className="text-right ml-4 min-w-0">
                {shown.matterId ? (
                  <button
                    type="button"
                    onClick={goToMatter}
                    className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium hover:underline truncate cursor-pointer max-w-full"
                  >
                    {shown.matterName || "View matter"}
                  </button>
                ) : (
                  <span className="text-on-surface font-medium">{shown.matterName || "-"}</span>
                )}
              </dd>
            </div>
          )}
          {(context || shown.clientName) && (
            <div className="flex items-start justify-between gap-4 text-sm">
              <dt className="flex items-center gap-2 text-on-surface-secondary shrink-0">
                <UserRound size={15} /> Client
              </dt>
              <dd className="text-on-surface font-medium text-right ml-4 min-w-0 truncate">{shown.clientName || context}</dd>
            </div>
          )}
          {shown.locationName && (
            <div className="flex items-start justify-between gap-4 text-sm">
              <dt className="flex items-center gap-2 text-on-surface-secondary shrink-0">
                <MapPin size={15} /> Location
              </dt>
              <dd className="text-on-surface font-medium text-right ml-4 min-w-0 truncate">{shown.locationName}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="flex items-center justify-end gap-2 px-6 py-4 bg-surface-alt rounded-b-lg border-t border-outline shrink-0">
        <Button type="secondary" onClick={onClose}>
          Close
        </Button>
        {shown.source === "matter" && shown.matterId ? (
          <Button type="primary" onClick={goToMatter} icon={<Briefcase size={15} />}>
            Go to matter
          </Button>
        ) : (
          <Button type="primary" onClick={goToCalendar} icon={<CalendarDays size={15} />}>
            Open calendar
          </Button>
        )}
      </div>
    </Modal>
  );
}
