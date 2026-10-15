import React from "react";
import { render, screen, act } from "@testing-library/react";
import useSeedOnOpen from "@/hooks/useSeedOnOpen";

// Mirrors how the modals use the hook: local form state, seeded from a prop the
// parent swaps between sessions.
function SeededForm({ open, record }: { open: boolean; record: { id: string; name: string } | null }) {
  const [name, setName] = React.useState("");
  const renders = React.useRef(0);
  renders.current += 1;

  useSeedOnOpen(open, () => setName(record?.name ?? ""), record?.id ?? null);

  return (
    <div>
      <span data-testid="name">{name}</span>
      <span data-testid="renders">{renders.current}</span>
      {/* Stands in for the user typing into the form. */}
      <button onClick={() => setName("typed by user")}>type</button>
    </div>
  );
}

const A = { id: "a", name: "Alpha" };
const B = { id: "b", name: "Beta" };

describe("useSeedOnOpen", () => {
  it("seeds when the modal opens", () => {
    const { rerender } = render(<SeededForm open={false} record={A} />);
    expect(screen.getByTestId("name")).toHaveTextContent("");

    rerender(<SeededForm open record={A} />);
    expect(screen.getByTestId("name")).toHaveTextContent("Alpha");
  });

  it("seeds on the FIRST committed render, leaving no frame with stale data", () => {
    // The regression this hook exists for: an effect-based reset commits the
    // opening render with the previous session's value still in state, so the
    // modal visibly flashes it. Seeding during render means the value is already
    // correct the first time anything is committed to the DOM.
    const { rerender } = render(<SeededForm open record={A} />);
    expect(screen.getByTestId("name")).toHaveTextContent("Alpha");

    // Close, then reopen against a different record.
    rerender(<SeededForm open={false} record={A} />);
    rerender(<SeededForm open record={B} />);
    expect(screen.getByTestId("name")).toHaveTextContent("Beta");
  });

  it("reseeds when the parent swaps the record while open", () => {
    const { rerender } = render(<SeededForm open record={A} />);
    expect(screen.getByTestId("name")).toHaveTextContent("Alpha");

    rerender(<SeededForm open record={B} />);
    expect(screen.getByTestId("name")).toHaveTextContent("Beta");
  });

  it("does not reseed on unrelated re-renders, so typed input survives", () => {
    const { rerender } = render(<SeededForm open record={A} />);
    expect(screen.getByTestId("name")).toHaveTextContent("Alpha");

    act(() => {
      screen.getByText("type").click();
    });
    expect(screen.getByTestId("name")).toHaveTextContent("typed by user");

    // A parent re-render for the SAME record must not wipe what the user typed.
    rerender(<SeededForm open record={{ ...A }} />);
    expect(screen.getByTestId("name")).toHaveTextContent("typed by user");

    // Swapping to a different record still reseeds.
    rerender(<SeededForm open record={B} />);
    expect(screen.getByTestId("name")).toHaveTextContent("Beta");
  });

  it("seeds a component that mounts already open", () => {
    render(<SeededForm open record={A} />);
    expect(screen.getByTestId("name")).toHaveTextContent("Alpha");
  });

  it("does not loop when the parent passes a new object identity each render", () => {
    // The key is `record.id`, never the object, so a fresh object per render is
    // harmless. A render-phase setState keyed on identity would loop forever.
    const { rerender } = render(<SeededForm open record={{ ...A }} />);
    const before = Number(screen.getByTestId("renders").textContent);
    rerender(<SeededForm open record={{ ...A }} />);
    rerender(<SeededForm open record={{ ...A }} />);
    const after = Number(screen.getByTestId("renders").textContent);
    expect(after - before).toBeLessThan(6);
  });
});
