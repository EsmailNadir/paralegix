import { screen } from "@testing-library/react";

export function expectCompactListSection(headingName: string, sortName: string) {
  const heading = screen.getByRole("heading", { name: headingName });
  const section = heading.closest(".space-y-4");
  expect(section).not.toBeNull();
  expect(section).toContainElement(screen.getByRole("button", { name: sortName }));
  expect(section?.parentElement).toHaveClass("space-y-6");
  expect(heading.parentElement).not.toHaveClass("mb-4");
  expect(heading.parentElement).not.toHaveClass("min-h-10");
  expect(heading.parentElement).toHaveClass("items-end");
}
