import { FileCapabilityError } from "./fileCapabilityRegistry.js";

export function validateEntryName(name: string): void {
  if (
    !name ||
    Buffer.byteLength(name, "utf8") > 255 ||
    name === "." ||
    name === ".." ||
    name.normalize("NFC") !== name ||
    [...name].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return (
        character === "/" ||
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f)
      );
    })
  ) {
    throw new FileCapabilityError(
      "REQUEST_INVALID",
      "File name is invalid.",
    );
  }
}
