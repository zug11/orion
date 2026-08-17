export const NOTE_IMAGE_ACCEPT =
  ".png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp";

const ORION_IMAGE_URL = /^orion-image:\/\/localhost\/([A-Za-z0-9_-]{12,80})$/;
const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

export function isSafeNoteImageUrl(value: string): boolean {
  return ORION_IMAGE_URL.test(value) || SAFE_IMAGE_DATA_URL.test(value);
}

export function noteImageAssetId(value: string): string | null {
  return ORION_IMAGE_URL.exec(value)?.[1] ?? null;
}

export function noteImageAlt(fileName: string): string {
  const withoutExtension = fileName.replace(/\.(?:png|jpe?g|gif|webp)$/i, "");
  return withoutExtension.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Image";
}

export function imageFilesFromTransfer(items: Iterable<File>): File[] {
  return Array.from(items).filter((file) =>
    /^(?:image\/(?:png|jpeg|jpg|gif|webp))$/i.test(file.type),
  );
}
