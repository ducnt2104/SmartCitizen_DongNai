//! Tier 1 — EXIF Camera Forensics & Exact Screen Resolution Detection.

use exif::{In, Reader, Tag};
use std::io::Cursor;

#[derive(Clone, Debug, Default)]
pub struct ExifForensics {
    pub has_exif_segment: bool,
    pub has_camera_make_model: bool,
    pub has_exposure_optics: bool,
    pub has_screenshot_software: bool,
    pub exact_screen_resolution: bool,
    pub is_png_without_exif: bool,
    pub make: Option<String>,
    pub model: Option<String>,
    pub software: Option<String>,
}

const COMMON_SCREEN_RESOLUTIONS: &[(u32, u32)] = &[
    // Popular iPhone / Android portrait & landscape exact pixel dimensions
    (1080, 2400),
    (1080, 2340),
    (1080, 2408),
    (1080, 2412),
    (1080, 2460),
    (1080, 1920),
    (1170, 2532),
    (1179, 2556),
    (1206, 2622),
    (1284, 2778),
    (1290, 2796),
    (1320, 2868),
    (1440, 3088),
    (1440, 3120),
    (1440, 3200),
    (720, 1600),
    (750, 1334),
    (828, 1792),
    // Desktop / Laptop monitors
    (1366, 768),
    (1440, 900),
    (1536, 864),
    (1600, 900),
    (1920, 1080),
    (1920, 1200),
    (2560, 1440),
    (2560, 1600),
    (2880, 1800),
    (3024, 1964),
    (3456, 2234),
    (3840, 2160),
];

const SCREENSHOT_SOFTWARE_KEYWORDS: &[&str] = &[
    "screenshot",
    "snipping",
    "snip & sketch",
    "lightshot",
    "greenshot",
    "sharex",
    "flameshot",
    "gyazo",
    "cleanShot",
    "screencapture",
    "android system",
];

pub fn inspect_exif_and_dimensions(raw_bytes: &[u8], width: u32, height: u32) -> ExifForensics {
    let mut out = ExifForensics::default();
    let is_png = raw_bytes.len() >= 8 && &raw_bytes[0..8] == b"\x89PNG\r\n\x1a\n";

    out.exact_screen_resolution = COMMON_SCREEN_RESOLUTIONS
        .iter()
        .any(|&(sw, sh)| (width == sw && height == sh) || (width == sh && height == sw));

    if let Ok(exif_data) = Reader::new().read_from_container(&mut Cursor::new(raw_bytes)) {
        out.has_exif_segment = true;
        if let Some(f) = exif_data.get_field(Tag::Make, In::PRIMARY) {
            let v = f.display_value().to_string().trim_matches('"').trim().to_string();
            if !v.is_empty() {
                out.make = Some(v);
            }
        }
        if let Some(f) = exif_data.get_field(Tag::Model, In::PRIMARY) {
            let v = f.display_value().to_string().trim_matches('"').trim().to_string();
            if !v.is_empty() {
                out.model = Some(v);
            }
        }
        out.has_camera_make_model = out.make.is_some() || out.model.is_some();

        let has_exp = exif_data.get_field(Tag::ExposureTime, In::PRIMARY).is_some();
        let has_iso = exif_data.get_field(Tag::PhotographicSensitivity, In::PRIMARY).is_some();
        let has_focal = exif_data.get_field(Tag::FocalLength, In::PRIMARY).is_some();
        let has_fnum = exif_data.get_field(Tag::FNumber, In::PRIMARY).is_some();
        out.has_exposure_optics = has_exp || has_iso || has_focal || has_fnum;

        let mut sw_combined = String::new();
        for tag in [Tag::Software, Tag::ImageDescription, Tag::UserComment] {
            if let Some(f) = exif_data.get_field(tag, In::PRIMARY) {
                sw_combined.push(' ');
                sw_combined.push_str(&f.display_value().to_string().to_lowercase());
            }
        }
        if !sw_combined.trim().is_empty() {
            out.software = Some(sw_combined.trim().to_string());
            out.has_screenshot_software = SCREENSHOT_SOFTWARE_KEYWORDS
                .iter()
                .any(|kw| sw_combined.contains(&kw.to_lowercase()));
        }
    }

    out.is_png_without_exif = is_png && !out.has_camera_make_model;
    out
}
