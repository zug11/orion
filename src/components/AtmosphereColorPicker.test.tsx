// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AtmosphereColorPicker } from "./AtmosphereColorPicker";

describe("AtmosphereColorPicker", () => {
  it("gives the two colour channels distinct accessible inputs", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<>
      <AtmosphereColorPicker label="Colour 1" value="#FF6699" fallback="#FFFFFF" onChange={first} showReset={false} />
      <AtmosphereColorPicker label="Colour 2" colorName="Shader secondary color" value="#66CFFF" fallback="#FFFFFF" onChange={second} showReset={false} />
    </>);
    fireEvent.change(screen.getByLabelText("Custom shader secondary color"), { target: { value: "#00aaee" } });
    expect(second).toHaveBeenLastCalledWith("#00AAEE");
    expect(first).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Shader color hex" })).toHaveValue("#FF6699");
    expect(screen.getByRole("textbox", { name: "Shader secondary color hex" })).toHaveValue("#66CFFF");
    expect(screen.queryByRole("button", { name: /Reset/ })).not.toBeInTheDocument();
  });
  it("accepts native color selection and full hex input without saving partial edits", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AtmosphereColorPicker value="" fallback="#A8B3FF" onChange={onChange} />,
    );
    const hex = screen.getByRole("textbox", { name: "Shader color hex" });
    expect(hex).toHaveValue("#A8B3FF");
    fireEvent.change(hex, { target: { value: "#ff" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(hex, { target: { value: "e94f8a" } });
    expect(onChange).toHaveBeenLastCalledWith("#E94F8A");
    rerender(<AtmosphereColorPicker value="#E94F8A" fallback="#A8B3FF" onChange={onChange} />);
    fireEvent.blur(hex);
    expect(hex).toHaveValue("#E94F8A");
    expect(screen.getByLabelText("Custom shader color")).toHaveValue("#e94f8a");

    fireEvent.change(screen.getByLabelText("Custom shader color"), {
      target: { value: "#08aaee" },
    });
    expect(onChange).toHaveBeenLastCalledWith("#08AAEE");
  });

  it("restores incomplete edits on blur and resets to the selected preset", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AtmosphereColorPicker value="#E94F8A" fallback="#D8B675" onChange={onChange} />,
    );
    const hex = screen.getByRole("textbox", { name: "Shader color hex" });
    fireEvent.change(hex, { target: { value: "#zzzzzz" } });
    expect(hex).toHaveAttribute("aria-invalid", "true");
    fireEvent.blur(hex);
    expect(hex).toHaveValue("#E94F8A");
    expect(hex).toHaveAttribute("aria-invalid", "false");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reset custom shader color" }));
    expect(onChange).toHaveBeenLastCalledWith("");
    rerender(<AtmosphereColorPicker value="" fallback="#D8B675" onChange={onChange} />);
    expect(hex).toHaveValue("#D8B675");
    expect(screen.queryByRole("button", { name: "Reset custom shader color" })).not.toBeInTheDocument();
  });
});
