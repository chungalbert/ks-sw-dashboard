import jsQR from "jsqr";

const MAX_DECODE_EDGE = 1600;

function decodeImageData(imageData: ImageData): string | null {
  const code = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: "attemptBoth",
  });
  const text = code?.data?.trim();
  return text || null;
}

/** Draw a bitmap onto a canvas, downscaling very large images for faster decode. */
function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  const scale = Math.min(1, MAX_DECODE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not read image.");
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * Decode the first QR payload from an image file (png/jpg/webp/…).
 * Throws when no QR is found or the image cannot be read.
 */
export async function decodeQrFromFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/") && !/\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) {
    throw new Error("Choose an image file that contains an otpauth QR code.");
  }
  const bitmap = await createImageBitmap(file);
  try {
    const text = decodeImageData(bitmapToImageData(bitmap));
    if (!text) throw new Error("No QR code found in image.");
    return text;
  } finally {
    bitmap.close();
  }
}

/** Decode QR from a video/canvas ImageData frame. Returns null when none found. */
export function decodeQrFromImageData(imageData: ImageData): string | null {
  return decodeImageData(imageData);
}
