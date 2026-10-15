import React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, fireEvent } from "@testing-library/react";

import Dropdown from "@/components/ui/Dropdown";

const options = [
  { label: "Option A", value: "a" },
  { label: "Option B", value: "b" },
  { label: "Option C", value: "c" },
];

describe("Dropdown", () => {
  it("renders options when opened", () => {
    render(
      React.createElement(Dropdown, {
        value: "",
        options,
        onChange: jest.fn(),
      })
    );
    // Click button to open
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Option A")).toBeInTheDocument();
    expect(screen.getByText("Option B")).toBeInTheDocument();
    expect(screen.getByText("Option C")).toBeInTheDocument();
  });

  it("renders its menu in a body portal by default, so a clipping parent cannot cut it off", async () => {
    const { container } = render(
      <div style={{ overflow: "hidden" }}>
        <Dropdown value="" options={options} onChange={jest.fn()} />
      </div>
    );
    fireEvent.click(screen.getByRole("button"));
    const listbox = await screen.findByRole("listbox");
    expect(container.contains(listbox)).toBe(false);
    expect(listbox.style.position).toBe("fixed");
  });

  it("keeps the inline menu when portal={false}", () => {
    const { container } = render(
      <Dropdown value="" options={options} onChange={jest.fn()} portal={false} />
    );
    fireEvent.click(screen.getByRole("button"));
    expect(container.contains(screen.getByRole("listbox"))).toBe(true);
  });

  it("shows the selected value", () => {
    render(
      React.createElement(Dropdown, {
        value: "b",
        options,
        onChange: jest.fn(),
      })
    );
    expect(screen.getByText("Option B")).toBeInTheDocument();
  });

  it("applies disabled state", () => {
    render(
      React.createElement(Dropdown, {
        value: "a",
        options,
        disabled: true,
      })
    );
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("shows placeholder text when no value is selected", () => {
    render(
      React.createElement(Dropdown, {
        value: "",
        options,
        onChange: jest.fn(),
        placeholder: "Pick one",
      })
    );
    expect(screen.getByText("Pick one")).toBeInTheDocument();
  });
});

describe("Dropdown search and capping", () => {
  const manyOptions = Array.from({ length: 250 }, (_, i) => ({
    label: `Client ${i}`,
    value: `c${i}`,
  }));

  it("hides the filter input for short lists", async () => {
    render(
      <Dropdown
        value=""
        onChange={() => {}}
        options={[{ label: "Open", value: "open" }, { label: "Closed", value: "closed" }]}
      />
    );
    await userEvent.click(screen.getByRole("button"));
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("shows the filter input once the list is long", async () => {
    render(<Dropdown value="" onChange={() => {}} options={manyOptions} />);
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("searchbox")).toBeInTheDocument();
  });

  it("caps rendered options and reports how many are hidden", async () => {
    render(<Dropdown value="" onChange={() => {}} options={manyOptions} />);
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getAllByRole("option")).toHaveLength(100);
    expect(screen.getByText(/150 more/i)).toBeInTheDocument();
  });

  it("filters options by the typed term", async () => {
    render(<Dropdown value="" onChange={() => {}} options={manyOptions} />);
    await userEvent.click(screen.getByRole("button"));
    await userEvent.type(screen.getByRole("searchbox"), "Client 24");
    // "Client 24", plus "Client 240".."Client 249" = 11 matches.
    expect(screen.getAllByRole("option")).toHaveLength(11);
  });

  it("focuses the filter input when the menu opens", async () => {
    render(<Dropdown value="" onChange={() => {}} options={manyOptions} />);
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("searchbox")).toHaveFocus();
  });

  it("hands focus back to the trigger when Tab leaves the filter input", async () => {
    render(<Dropdown value="" onChange={() => {}} options={manyOptions} />);
    const trigger = screen.getByRole("button");
    await userEvent.click(trigger);
    const search = screen.getByRole("searchbox");
    expect(search).toHaveFocus();

    // fireEvent, not userEvent.tab(): userEvent emulates the browser's default
    // tab movement itself, which would overwrite the handler's focus call and
    // hide what this test is about. Dispatching the raw keydown isolates the
    // handler, whose job is to put focus back on the trigger so the browser's
    // own default action then continues from the trigger's document position
    // rather than from the portal node at the end of <body>.
    fireEvent.keyDown(search, { key: "Tab" });
    expect(trigger).toHaveFocus();
  });

  it("selects the option the keyboard lands on after filtering", async () => {
    const onChange = jest.fn();
    render(<Dropdown value="" onChange={onChange} options={manyOptions} />);
    await userEvent.click(screen.getByRole("button"));
    await userEvent.type(screen.getByRole("searchbox"), "Client 241");
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("c241");
  });

  it("reports no matches when the filter excludes everything", async () => {
    render(<Dropdown value="" onChange={() => {}} options={manyOptions} />);
    await userEvent.click(screen.getByRole("button"));
    await userEvent.type(screen.getByRole("searchbox"), "zzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });
});
