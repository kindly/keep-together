//! The server's re-encode of an uploaded page (g1q12): whatever the phone
//! sent, what is stored is a greyscale JPEG the server wrote itself.
//!
//! - Only JPEG and PNG are decoded, recognised by their bytes (never by
//!   a header the client sets).
//! - The size is read from the header before anything is decoded, and
//!   refused past [`MAX_SIDE`] a side or [`MAX_PIXELS`] in all: a
//!   decompression bomb is a small file that claims a huge image, and
//!   is refused there. The decoder also runs under `image::Limits` (its
//!   own dimension and allocation caps), in case a header lies.
//! - At most [`DECODES`] decodes run at once, so a burst of uploads can't
//!   take the machine's memory.
//! - Greyscale (an exact replica keeps a faint tick or signature that a
//!   1-bit threshold could drop), the long side capped at [`LONG_SIDE`]
//!   (150 dpi A4), encoded from raw pixels, so no EXIF, GPS or other
//!   metadata survives. The quality steps down until the page fits
//!   [`MAX_PAGE_BYTES`]; still over at the lowest is refused.

use std::io::Cursor;
use std::sync::{Condvar, Mutex};

use contracts::Problem;
use giftaid::scans::MAX_PAGE_BYTES;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ImageFormat, ImageReader, Limits};

use crate::error::ApiError;

/// The longest side an upload may claim.
pub const MAX_SIDE: u32 = 6000;
/// Pixels an upload may claim (24 MP: more than a phone photo of A4).
pub const MAX_PIXELS: u64 = 24_000_000;
/// The long side of a stored page: A4 at 150 dpi.
pub const LONG_SIDE: u32 = 1754;
/// Decodes at once.
pub const DECODES: usize = 2;
/// JPEG qualities tried in turn.
const QUALITIES: [u8; 4] = [80, 70, 60, 50];

/// A page as stored.
#[derive(Debug)]
pub struct Processed {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

fn refused(message: impl Into<String>) -> ApiError {
    ApiError::Invalid {
        problems: vec![Problem::new("image", message)],
    }
}

/// A counting semaphore for blocking threads.
struct Permits {
    free: Mutex<usize>,
    freed: Condvar,
}

static PERMITS: Permits = Permits {
    free: Mutex::new(DECODES),
    freed: Condvar::new(),
};

struct Permit;

impl Permit {
    fn take() -> Self {
        let mut free = PERMITS.free.lock().unwrap_or_else(|e| e.into_inner());
        while *free == 0 {
            free = PERMITS.freed.wait(free).unwrap_or_else(|e| e.into_inner());
        }
        *free -= 1;
        Permit
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        *PERMITS.free.lock().unwrap_or_else(|e| e.into_inner()) += 1;
        PERMITS.freed.notify_one();
    }
}

/// Re-encode `raw` (module docs). Blocking and CPU-bound: run it off the
/// async runtime. Refusals are `422 invalid` on `image`.
pub fn reencode(raw: &[u8]) -> Result<Processed, ApiError> {
    if raw.is_empty() {
        return Err(refused("No image was sent"));
    }
    let format = image::guess_format(raw).map_err(|_| refused("Not a JPEG or PNG image"))?;
    if !matches!(format, ImageFormat::Jpeg | ImageFormat::Png) {
        return Err(refused("Not a JPEG or PNG image"));
    }
    let reader = || {
        let mut r = ImageReader::with_format(Cursor::new(raw), format);
        let mut limits = Limits::default();
        limits.max_image_width = Some(MAX_SIDE);
        limits.max_image_height = Some(MAX_SIDE);
        // RGBA at the pixel cap, and the decoder's own buffers.
        limits.max_alloc = Some(MAX_PIXELS * 4 + (64 << 20));
        r.limits(limits);
        r
    };
    let (w, h) = reader()
        .into_dimensions()
        .map_err(|_| refused("The image can't be read"))?;
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE || u64::from(w) * u64::from(h) > MAX_PIXELS
    {
        return Err(refused(format!(
            "The image is too large (at most {MAX_SIDE} pixels a side)"
        )));
    }
    let _permit = Permit::take();
    let decoded = reader()
        .decode()
        .map_err(|_| refused("The image can't be read"))?;
    let mut grey = decoded.to_luma8();
    drop(decoded);
    let long = grey.width().max(grey.height());
    if long > LONG_SIDE {
        let scale = f64::from(LONG_SIDE) / f64::from(long);
        let nw = ((f64::from(grey.width()) * scale).round() as u32).max(1);
        let nh = ((f64::from(grey.height()) * scale).round() as u32).max(1);
        grey = image::imageops::resize(&grey, nw, nh, FilterType::Triangle);
    }
    for quality in QUALITIES {
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, quality)
            .encode_image(&grey)
            .map_err(ApiError::internal)?;
        if bytes.len() as i64 <= MAX_PAGE_BYTES {
            return Ok(Processed {
                bytes,
                width: grey.width(),
                height: grey.height(),
            });
        }
    }
    Err(refused(format!(
        "The page is still over {} KB as a greyscale JPEG: photograph it again in better light",
        MAX_PAGE_BYTES / 1024
    )))
}

#[cfg(test)]
mod tests {
    use image::{GrayImage, ImageEncoder, Luma, Rgb, RgbImage};

    use super::*;

    fn jpeg(img: &RgbImage) -> Vec<u8> {
        let mut out = Vec::new();
        JpegEncoder::new_with_quality(&mut out, 90)
            .encode_image(img)
            .unwrap();
        out
    }

    /// A JPEG with an EXIF segment (APP1) spliced in after SOI, as a
    /// phone's camera writes one.
    fn with_exif(jpeg: &[u8]) -> Vec<u8> {
        let payload = b"Exif\0\0MM\0*\0\0\0\x08GPS 51.5N 0.12W";
        let len = (payload.len() + 2) as u16;
        let mut out = jpeg[..2].to_vec();
        out.extend([0xFF, 0xE1]);
        out.extend(len.to_be_bytes());
        out.extend(payload);
        out.extend(&jpeg[2..]);
        out
    }

    fn page(w: u32, h: u32) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| {
            Rgb([(x % 251) as u8, (y % 241) as u8, ((x + y) % 7 * 30) as u8])
        })
    }

    #[test]
    fn the_stored_page_is_a_greyscale_jpeg_with_no_exif_and_capped_size() {
        let raw = with_exif(&jpeg(&page(2480, 3508)));
        assert!(raw.windows(4).any(|w| w == b"Exif"));
        let out = reencode(&raw).unwrap();
        assert_eq!((out.width, out.height), (1240, 1754));
        assert!(out.bytes.len() as i64 <= MAX_PAGE_BYTES);
        assert!(!out.bytes.windows(4).any(|w| w == b"Exif"));
        assert!(!out.bytes.windows(3).any(|w| w == b"GPS"));
        let back = image::load_from_memory_with_format(&out.bytes, ImageFormat::Jpeg).unwrap();
        assert_eq!(back.color(), image::ColorType::L8);
    }

    #[test]
    fn a_png_is_taken_and_a_small_page_keeps_its_size() {
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(
                GrayImage::from_pixel(600, 800, Luma([200])).as_raw(),
                600,
                800,
                image::ExtendedColorType::L8,
            )
            .unwrap();
        let out = reencode(&png).unwrap();
        assert_eq!((out.width, out.height), (600, 800));
    }

    #[test]
    fn not_an_image_is_refused() {
        for raw in [&b""[..], b"%PDF-1.7 hello", b"GIF89a\x01\x00\x01\x00"] {
            assert!(
                matches!(reencode(raw), Err(ApiError::Invalid { .. })),
                "{raw:?}"
            );
        }
        // JPEG magic, then garbage.
        assert!(matches!(
            reencode(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 1, 2, 3]),
            Err(ApiError::Invalid { .. })
        ));
    }

    /// A PNG header claiming 50,000 × 50,000 (2.5 GP) and almost no data:
    /// refused from the header, before any pixel is allocated.
    #[test]
    fn a_decompression_bomb_is_refused_from_its_header() {
        let mut png = Vec::new();
        png.extend(b"\x89PNG\r\n\x1a\n");
        let mut ihdr = Vec::new();
        ihdr.extend(50_000u32.to_be_bytes());
        ihdr.extend(50_000u32.to_be_bytes());
        ihdr.extend([8, 0, 0, 0, 0]); // 8-bit grey
        png.extend((ihdr.len() as u32).to_be_bytes());
        let mut chunk = b"IHDR".to_vec();
        chunk.extend(&ihdr);
        let crc = crc32(&chunk);
        png.extend(&chunk);
        png.extend(crc.to_be_bytes());
        let err = reencode(&png).unwrap_err();
        assert!(matches!(err, ApiError::Invalid { .. }), "{err:?}");
        // Under the side cap but over the pixel cap.
        let wide = page(5000, 5000);
        assert!(matches!(
            reencode(&jpeg(&wide)),
            Err(ApiError::Invalid { .. })
        ));
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for b in bytes {
            crc ^= u32::from(*b);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }
}
