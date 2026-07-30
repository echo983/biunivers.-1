import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EntryIdenticon } from "./EntryIdenticon";

describe("EntryIdenticon", () => {
  it("renders stable SVG geometry from a valid Entry ID", () => {
    const { container, rerender } = render(
      <EntryIdenticon entryId={"1".repeat(32)} size={42} />,
    );
    const first = container.querySelector("svg")?.innerHTML;
    expect(first).toContain("<path");

    rerender(<EntryIdenticon entryId={"1".repeat(32)} size={42} />);
    expect(container.querySelector("svg")?.innerHTML).toBe(first);

    rerender(<EntryIdenticon entryId={"2".repeat(32)} size={42} />);
    expect(container.querySelector("svg")?.innerHTML).not.toBe(first);
  });

  it("falls back to the ordinary file glyph for an invalid Entry ID", () => {
    const { container } = render(
      <EntryIdenticon entryId="invalid" size={18} />,
    );
    expect(container).toHaveTextContent("📄");
    expect(container.querySelector("svg")).toBeNull();
  });
});
