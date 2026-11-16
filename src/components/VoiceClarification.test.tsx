// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceClarification, type VoiceClarificationProps } from "./VoiceClarification";

afterEach(cleanup);
const question = "Which research request would you like the result for?";
const choices = [
  { id: "product:1", label: "Product possibilities", description: "Ready to discuss" },
  { id: "technical:2", label: "Technical possibilities", description: "Still researching" },
];
function props(overrides: Partial<VoiceClarificationProps> = {}): VoiceClarificationProps {
  return { clarificationId: "question:1", question, choices, onSubmit: vi.fn(), onCancel: vi.fn(), ...overrides };
}

describe("VoiceClarification", () => {
  it("offers actual choices without preselecting or submitting one", () => {
    const options = props(); render(<VoiceClarification {...options} />);
    expect(screen.getByRole("form", { name: question })).toBeInTheDocument();
    expect(screen.getAllByRole("radio").every(radio => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(options.onSubmit).not.toHaveBeenCalled();
    const radio = screen.getByRole("radio", { name: "Technical possibilities" });
    fireEvent.click(radio);
    expect(radio).toBeChecked();
    expect(radio).toHaveAccessibleDescription("Still researching");
    expect(options.onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(options.onSubmit).toHaveBeenCalledWith({ choiceId: "technical:2", text: "" });
  });

  it("submits a selected choice and optional literal detail once", () => {
    const options = props(); render(<VoiceClarification {...options} />);
    fireEvent.click(screen.getByRole("radio", { name: "Product possibilities" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your reply (optional)" }), { target: { value: "  Focus on the boldest ideas.  " } });
    fireEvent.submit(screen.getByRole("form"));
    fireEvent.submit(screen.getByRole("form"));
    expect(options.onSubmit).toHaveBeenCalledExactlyOnceWith({ choiceId: "product:1", text: "Focus on the boldest ideas." });
    expect(screen.getByRole("button", { name: "Continuing…" })).toBeDisabled();
  });

  it("accepts a written alternative without requiring a suggested choice", () => {
    const options = props(); render(<VoiceClarification {...options} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "The product ideas and their strongest competitors" } });
    fireEvent.submit(screen.getByRole("form"));
    expect(options.onSubmit).toHaveBeenCalledWith({ text: "The product ideas and their strongest competitors" });
  });

  it("requires an answer when there are no choices and preserves multiline input", () => {
    const options = props({ choices: [] }); render(<VoiceClarification {...options} />);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    const textarea = screen.getByRole("textbox", { name: "Your reply" });
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.submit(screen.getByRole("form"));
    expect(options.onSubmit).not.toHaveBeenCalled();
    fireEvent.change(textarea, { target: { value: "First idea\nSecond idea" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(options.onSubmit).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByRole("form"));
    expect(options.onSubmit).toHaveBeenCalledWith({ text: "First idea\nSecond idea" });
  });

  it("keeps cancellation available while a submitted answer is being handled", () => {
    const options = props({ busy: true }); render(<VoiceClarification {...options} />);
    expect(screen.getByRole("form")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("radio", { name: "Product possibilities" })).toBeDisabled();
    expect(screen.getByRole("textbox")).toBeDisabled();
    fireEvent.submit(screen.getByRole("form"));
    expect(options.onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(options.onCancel).toHaveBeenCalledOnce();
  });

  it("handles Escape locally without confusing IME composition with cancellation", () => {
    const options = props(), outside = vi.fn();
    render(<div onKeyDown={outside}><VoiceClarification {...options} /></div>);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape", isComposing: true });
    expect(options.onCancel).not.toHaveBeenCalled();
    outside.mockClear();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(options.onCancel).toHaveBeenCalledOnce();
    expect(outside).not.toHaveBeenCalled();
  });

  it("resets selection and text for a new captured question even when wording repeats", () => {
    const options = props(); const view = render(<VoiceClarification {...options} />);
    fireEvent.click(screen.getByRole("radio", { name: "Product possibilities" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Earlier direction" } });
    view.rerender(<VoiceClarification {...options} clarificationId="question:2" />);
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("radio", { name: "Product possibilities" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("retains a failed answer for an explicit retry after busy clears", () => {
    const options = props(); const view = render(<VoiceClarification {...options} />);
    fireEvent.click(screen.getByRole("radio", { name: "Product possibilities" }));
    fireEvent.submit(screen.getByRole("form"));
    view.rerender(<VoiceClarification {...options} busy />);
    view.rerender(<VoiceClarification {...options} busy={false} />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    fireEvent.submit(screen.getByRole("form"));
    expect(options.onSubmit).toHaveBeenCalledTimes(2);
  });

  it("leaves an immediately rejected answer ready to retry without requiring an input change", () => {
    const onSubmit = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<VoiceClarification {...props({ onSubmit })} />);
    fireEvent.click(screen.getByRole("radio", { name: "Product possibilities" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this direction." } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Product possibilities" })).toBeChecked();
    expect(screen.getByRole("textbox")).toHaveValue("Keep this direction.");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[0][0]).toEqual(onSubmit.mock.calls[1][0]);
    expect(screen.getByRole("button", { name: "Continuing…" })).toBeDisabled();
  });
});
