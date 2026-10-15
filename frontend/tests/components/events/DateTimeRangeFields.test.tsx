/**
 * The Start and End rows every event and task form shares. Each row is a day
 * picker and a time picker writing one 'YYYY-MM-DDTHH:mm' value, so the cases
 * here are about the two halves not clobbering each other: a new day keeps the
 * chosen time, and a first end pick lands after the start rather than at a
 * fixed default.
 */
import React, { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import DateTimeRangeFields from "@/components/eventComp/DateTimeRangeFields";

function Harness({
  allDay = false,
  initialStart = "",
  initialEnd = "",
  onChange,
}: {
  allDay?: boolean;
  initialStart?: string;
  initialEnd?: string;
  onChange: (start: string, end: string) => void;
}) {
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  return (
    <DateTimeRangeFields
      idPrefix="t"
      allDay={allDay}
      startLabel="Start"
      startRequired
      start={start}
      onStartChange={(v) => { setStart(v); onChange(v, end); }}
      end={end}
      onEndChange={(v) => { setEnd(v); onChange(start, v); }}
    />
  );
}

/** Opens a day picker and picks a day of the month it opens on. */
function pickDay(trigger: HTMLElement, day: number) {
  fireEvent.click(trigger);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Choose a date" })).getByRole("button", { name: String(day) }));
}

describe("DateTimeRangeFields", () => {
  it('preserves the default end offset when its first date falls in the repeated hour', () => {
    const onChange = jest.fn();
    render(<Harness initialStart="2026-11-01T01:30" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /^End No end/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a date' })).getAllByRole('button', { name: '1' })[0]);
    expect(onChange).toHaveBeenLastCalledWith('2026-11-01T01:30', '2026-11-01T01:30-08:00');
  });
  it('keeps a repeated-hour offset when its date is picked again', () => {
    const onChange = jest.fn();
    render(<Harness initialStart="2026-11-01T01:00-08:00" initialEnd="2026-11-01T01:30-08:00" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /^End Nov 1/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Choose a date' })).getAllByRole('button', { name: '1' })[0]);
    expect(onChange).toHaveBeenLastCalledWith('2026-11-01T01:00-08:00', '2026-11-01T01:30-08:00');
  });
  it("lands a first end on the start day after the start, even when the default end is the next day", () => {
    // Start 23:30: the default end is 00:30 the next day, and that time on the
    // start day would come before the start.
    const onChange = jest.fn();
    render(<Harness initialStart="2026-09-05T23:30" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /^End No end/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Choose a date" })).getAllByRole("button", { name: "5" })[0]);
    expect(onChange).toHaveBeenLastCalledWith("2026-09-05T23:30", "2026-09-06T00:30");
    expect(screen.queryByText("The end must be after the start.")).not.toBeInTheDocument();
  });

  it("moves an end onto the start day after the start when its kept time would fall before it", () => {
    const onChange = jest.fn();
    render(<Harness initialStart="2026-09-05T10:00" initialEnd="2026-09-07T09:00" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /^End Sep 7/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Choose a date" })).getAllByRole("button", { name: "5" })[0]);
    expect(onChange).toHaveBeenLastCalledWith("2026-09-05T10:00", "2026-09-05T11:00");
  });

  it("keeps the kept time when the new end day still comes after the start", () => {
    const onChange = jest.fn();
    render(<Harness initialStart="2026-09-05T10:00" initialEnd="2026-09-07T09:00" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /^End Sep 7/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Choose a date" })).getAllByRole("button", { name: "6" })[0]);
    expect(onChange).toHaveBeenLastCalledWith("2026-09-05T10:00", "2026-09-06T09:00");
  });

  it("leaves an end day picked before the start day as picked, and says why", () => {
    const onChange = jest.fn();
    render(<Harness initialStart="2026-09-05T10:00" initialEnd="2026-09-05T11:00" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /^End Sep 5/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Choose a date" })).getAllByRole("button", { name: "3" })[0]);
    expect(onChange).toHaveBeenLastCalledWith("2026-09-05T10:00", "2026-09-03T11:00");
    expect(screen.getByText("The end must be after the start.")).toBeInTheDocument();
  });

  it("shows a day and a time on each row, and only the days when all-day", () => {
    const { unmount } = render(<Harness initialStart="2026-05-20T13:00" onChange={jest.fn()} />);
    expect(screen.getByRole("button", { name: /^Start \* May 20, 2026/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start time" })).toHaveTextContent("1:00 PM");
    expect(screen.getByRole("button", { name: /^End No end/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End time" })).toHaveTextContent("Time");
    unmount();

    render(<Harness allDay initialStart="2026-05-20T00:00" onChange={jest.fn()} />);
    expect(screen.queryByRole("button", { name: "Start time" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "End time" })).not.toBeInTheDocument();
  });

  it("keeps the start time when the start day changes", () => {
    const onChange = jest.fn();
    render(<Harness initialStart="2026-05-20T09:15" onChange={onChange} />);

    pickDay(screen.getByRole("button", { name: /^Start \*/ }), 18);

    expect(onChange).toHaveBeenLastCalledWith("2026-05-18T09:15", "");
  });

  it("puts a first end day an hour after the start time, not at a fixed default", () => {
    const onChange = jest.fn();
    render(<Harness initialStart="2026-05-20T15:30" onChange={onChange} />);

    pickDay(screen.getByRole("button", { name: /^End No end/ }), 21);

    expect(onChange).toHaveBeenLastCalledWith("2026-05-20T15:30", "2026-05-21T16:30");
  });

  it("seeds the end an hour after the start when the end time is opened empty", () => {
    const onChange = jest.fn();
    render(<Harness initialStart="2026-05-20T23:30" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "End time" }));

    // Past midnight, so the end lands on the next day.
    expect(onChange).toHaveBeenLastCalledWith("2026-05-20T23:30", "2026-05-21T00:30");
  });

  it("holds an all-day end as the last day picked", () => {
    const onChange = jest.fn();
    render(<Harness allDay initialStart="2026-05-18T00:00" onChange={onChange} />);

    pickDay(screen.getByRole("button", { name: /^End No end/ }), 20);

    expect(onChange).toHaveBeenLastCalledWith("2026-05-18T00:00", "2026-05-20");
  });

  it("keeps the end disabled until there is a start for it to come after", () => {
    render(<Harness onChange={jest.fn()} />);

    expect(screen.getByRole("button", { name: /^End No end/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "End time" })).toBeDisabled();
  });

  it("says why when the end is before the start", () => {
    render(<Harness initialStart="2026-05-20T13:00" initialEnd="2026-05-20T12:00" onChange={jest.fn()} />);

    expect(screen.getByText("The end must be after the start.")).toBeInTheDocument();
  });

  // A required end that is empty keeps the caller's Save disabled; the row has
  // to say why, since an empty end otherwise fits any start.
  it("says why when a required end is empty", () => {
    const props = {
      idPrefix: "t", allDay: false, startLabel: "Start", start: "2026-05-20T13:00",
      onStartChange: jest.fn(), onEndChange: jest.fn(), endRequired: "Google and Outlook events need an end time.",
    };
    const { rerender } = render(<DateTimeRangeFields {...props} end="2026-05-20T14:00" />);
    expect(screen.getByText("End *")).toBeInTheDocument();
    expect(screen.queryByText("Google and Outlook events need an end time.")).not.toBeInTheDocument();

    rerender(<DateTimeRangeFields {...props} end="" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Google and Outlook events need an end time.");
  });
});
