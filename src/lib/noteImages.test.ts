import { describe, expect, it } from "vitest";
import {
  imageFilesFromTransfer,
  isSafeNoteImageUrl,
  noteImageAlt,
  noteImageAssetId,
} from "./noteImages";

describe("note images", () => {
  it("accepts only bounded Orion references and inert raster data URLs", () => {
    const src = "orion-image://localhost/image_Abc-123456789";
    expect(isSafeNoteImageUrl(src)).toBe(true);
    expect(noteImageAssetId(src)).toBe("image_Abc-123456789");
    expect(isSafeNoteImageUrl("orion-image://localhost/../../vault.json")).toBe(false);
    expect(isSafeNoteImageUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isSafeNoteImageUrl("data:image/png;base64,AQID")).toBe(true);
  });

  it("turns a filename into useful accessible alternative text", () => {
    expect(noteImageAlt("system_architecture-final.png")).toBe(
      "system architecture final",
    );
    expect(noteImageAlt(".png")).toBe("Image");
  });

  it("keeps supported raster files from clipboard and drop payloads", () => {
    const png = new File(["png"], "diagram.png", { type: "image/png" });
    const svg = new File(["svg"], "unsafe.svg", { type: "image/svg+xml" });
    expect(imageFilesFromTransfer([png, svg])).toEqual([png]);
  });
});
