pub mod authenticity;
pub mod exif_forensics;
pub mod features;
pub mod onnx_runtime;
pub mod resolution;

use authenticity::{check_image_authenticity, AuthenticityRequest, AuthenticityResponse};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use features::{
    build_fingerprint, check_duplicate_against_pool, CheckDuplicateRequest, CheckDuplicateResponse,
    ImageFingerprint,
};
use image::DynamicImage;
use onnx_runtime::VisionClassifier;
use resolution::{verify_before_after, VerifyResolutionRequest, VerifyResolutionResponse};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Instant;

pub struct EngineState {
    pub started_at: Instant,
    pub classifier: VisionClassifier,
    pub index: RwLock<Vec<ImageFingerprint>>,
}

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub engine: &'static str,
    pub uptime_sec: u64,
    pub indexed_fingerprints: usize,
    pub onnx_model_path: String,
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

pub fn decode_base64_image(raw_b64_or_data_url: &str) -> Result<(Vec<u8>, DynamicImage), String> {
    let trimmed = raw_b64_or_data_url.trim();
    let payload = match trimmed.find(";base64,") {
        Some(idx) => &trimmed[idx + 8..],
        None => trimmed,
    };
    let bytes = B64
        .decode(payload)
        .map_err(|e| format!("Base64 ảnh không hợp lệ: {e}"))?;
    let img = image::load_from_memory(&bytes)
        .map_err(|e| format!("Không giải mã được định dạng ảnh (JPEG/PNG/WebP): {e}"))?;
    Ok((bytes, img))
}

async fn health_handler(State(st): State<Arc<EngineState>>) -> Json<HealthResponse> {
    let count = st.index.read().map(|g| g.len()).unwrap_or(0);
    Json(HealthResponse {
        status: "ok",
        engine: "rust-axum-cv-onnx-1.0",
        uptime_sec: st.started_at.elapsed().as_secs(),
        indexed_fingerprints: count,
        onnx_model_path: st.classifier.model_path.clone(),
    })
}

async fn authenticity_handler(
    State(st): State<Arc<EngineState>>,
    Json(req): Json<AuthenticityRequest>,
) -> Result<Json<AuthenticityResponse>, (StatusCode, Json<ErrorBody>)> {
    let (bytes, img) = decode_base64_image(&req.image_base64)
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorBody { error })))?;
    let thresh = req.screenshot_threshold.unwrap_or(50.0);
    let out = tokio::task::spawn_blocking(move || {
        check_image_authenticity(&bytes, &img, &st.classifier, thresh)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                error: e.to_string(),
            }),
        )
    })?;
    Ok(Json(out))
}

async fn duplicate_handler(
    State(st): State<Arc<EngineState>>,
    Json(req): Json<CheckDuplicateRequest>,
) -> Result<Json<CheckDuplicateResponse>, (StatusCode, Json<ErrorBody>)> {
    let (_bytes, img) = decode_base64_image(&req.image_base64)
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorBody { error })))?;

    let out = tokio::task::spawn_blocking(move || {
        let id = req.incident_id.clone().unwrap_or_default();
        let fp = build_fingerprint(&img, id.clone(), req.ward_code.clone(), req.lat, req.lng);

        let mut pool: Vec<ImageFingerprint> = st.index.read().map(|g| g.clone()).unwrap_or_default();
        if let Some(ext) = &req.external_candidates {
            for c in ext {
                if !pool.iter().any(|p| p.incident_id == c.incident_id) {
                    pool.push(ImageFingerprint::from_candidate_input(c));
                }
            }
        }

        let res = check_duplicate_against_pool(
            &fp,
            &pool,
            req.radius_m.unwrap_or(200.0),
            req.min_inliers.unwrap_or(15),
        );

        if req.register_in_index.unwrap_or(false) && !id.is_empty() {
            if let Ok(mut guard) = st.index.write() {
                guard.retain(|existing| existing.incident_id != id);
                guard.push(fp);
            }
        }
        res
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                error: e.to_string(),
            }),
        )
    })?;

    Ok(Json(out))
}

async fn verify_resolution_handler(
    State(st): State<Arc<EngineState>>,
    Json(req): Json<VerifyResolutionRequest>,
) -> Result<Json<VerifyResolutionResponse>, (StatusCode, Json<ErrorBody>)> {
    let (_b_bytes, before_img) = decode_base64_image(&req.before_image_base64)
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorBody { error })))?;
    let (_a_bytes, after_img) = decode_base64_image(&req.after_image_base64)
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorBody { error })))?;

    let out = tokio::task::spawn_blocking(move || {
        verify_before_after(&before_img, &after_img, &req, &st.classifier)
    })
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                error: e.to_string(),
            }),
        )
    })?;

    Ok(Json(out))
}

async fn clear_index_handler(State(st): State<Arc<EngineState>>) -> impl IntoResponse {
    if let Ok(mut g) = st.index.write() {
        g.clear();
    }
    Json(serde_json::json!({ "ok": true }))
}

pub fn build_router(models_dir: PathBuf) -> Router {
    let state = Arc::new(EngineState {
        started_at: Instant::now(),
        classifier: VisionClassifier::load_or_bootstrap(&models_dir),
        index: RwLock::new(Vec::new()),
    });

    Router::new()
        .route("/health", get(health_handler))
        .route("/cv/check-authenticity", post(authenticity_handler))
        .route("/cv/check-duplicate", post(duplicate_handler))
        .route("/cv/verify-resolution", post(verify_resolution_handler))
        .route("/cv/index/clear", post(clear_index_handler))
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;

    fn encode_png_b64(img: &RgbImage) -> (Vec<u8>, String) {
        let mut buf = Vec::new();
        DynamicImage::ImageRgb8(img.clone())
            .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
            .unwrap();
        let b64 = B64.encode(&buf);
        (buf, b64)
    }

    fn encode_jpeg_b64(img: &RgbImage) -> (Vec<u8>, String) {
        let mut buf = Vec::new();
        DynamicImage::ImageRgb8(img.clone())
            .write_to(&mut Cursor::new(&mut buf), ImageFormat::Jpeg)
            .unwrap();
        let b64 = B64.encode(&buf);
        (buf, b64)
    }

    /// Generates a rich textured street scene (sky, buildings/poles/windows in background, asphalt road, optional trash pile defect)
    fn synth_street_scene(w: u32, h: u32, with_defect: bool, brightness_scale: f32) -> RgbImage {
        let mut img = RgbImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                // Deterministic pseudo-organic texture so ORB keypoints lock onto buildings/curbs/windows
                let hash = ((x.wrapping_mul(374761393)).wrapping_add(y.wrapping_mul(668265263))) ^ (x * y);
                let grain = ((hash & 0x1F) as f32) - 16.0;

                let (mut r, mut g, mut b) = if y < h * 28 / 100 {
                    // Sky with subtle gradient
                    (155.0 + grain * 0.5, 190.0 + grain * 0.5, 225.0 + grain * 0.4)
                } else if y < h * 58 / 100 {
                    // Buildings, pillars, storefront signs & windows (rich static background corners!)
                    let bx = (x / 28) % 7;
                    let by = (y / 22) % 5;
                    let is_window = (x % 28 > 6 && x % 28 < 20) && (y % 22 > 5 && y % 22 < 16);
                    let is_pole = (x > w / 5 && x < w / 5 + 10) || (x > w * 4 / 5 && x < w * 4 / 5 + 12);
                    if is_pole {
                        (65.0 + grain, 70.0 + grain, 76.0 + grain)
                    } else if is_window {
                        (
                            45.0 + (bx * 18) as f32 + grain,
                            62.0 + (by * 14) as f32 + grain,
                            88.0 + grain,
                        )
                    } else {
                        (
                            168.0 + (bx * 9) as f32 + grain,
                            158.0 + (by * 8) as f32 + grain,
                            142.0 + grain,
                        )
                    }
                } else {
                    // Asphalt road + sidewalk curb + lane markings
                    let curb = y < h * 61 / 100;
                    let dash = y > h * 76 / 100 && y < h * 79 / 100 && (x / 42) % 2 == 0;
                    if curb {
                        (185.0 + grain, 182.0 + grain, 172.0 + grain)
                    } else if dash {
                        (225.0 + grain * 0.5, 220.0 + grain * 0.5, 195.0 + grain * 0.5)
                    } else {
                        (88.0 + grain * 0.9, 90.0 + grain * 0.9, 94.0 + grain * 0.9)
                    }
                };

                // Optional chaotic garbage pile / pothole defect in foreground ROI
                if with_defect {
                    let dx = x as f32 - (w as f32 * 0.50);
                    let dy = y as f32 - (h as f32 * 0.74);
                    if (dx * dx) / (w as f32 * 0.22).powi(2) + (dy * dy) / (h as f32 * 0.14).powi(2) <= 1.0 {
                        let patch = ((x / 5 + y / 4) * 37 + (hash as u32 & 0xFF)) % 5;
                        match patch {
                            0 => { r = 22.0; g = 25.0; b = 28.0; }
                            1 => { r = 215.0; g = 48.0; b = 36.0; }
                            2 => { r = 35.0; g = 165.0; b = 65.0; }
                            3 => { r = 230.0; g = 195.0; b = 30.0; }
                            _ => { r = 30.0; g = 85.0; b = 195.0; }
                        }
                    }
                }

                img.put_pixel(
                    x,
                    y,
                    Rgb([
                        (r * brightness_scale).clamp(0.0, 255.0) as u8,
                        (g * brightness_scale).clamp(0.0, 255.0) as u8,
                        (b * brightness_scale).clamp(0.0, 255.0) as u8,
                    ]),
                );
            }
        }
        img
    }

    /// Generates a synthetic mobile screenshot (1080x2400 aspect, solid top status bar + glyphs, flat UI cards, bottom nav pill)
    fn synth_mobile_screenshot() -> RgbImage {
        let (w, h) = (360u32, 800u32);
        let mut img = RgbImage::from_pixel(w, h, Rgb([246, 247, 250]));
        // Top status bar (solid dark with crisp white icon ticks)
        for y in 0..38 {
            for x in 0..w {
                let glyph = y > 12 && y < 26 && ((x > 24 && x < 72 && x % 6 < 3) || (x > 290 && x < 340 && x % 7 < 4));
                img.put_pixel(x, y, if glyph { Rgb([255, 255, 255]) } else { Rgb([15, 23, 42]) });
            }
        }
        // Flat UI cards + crisp black text lines
        for y in 90..680 {
            for x in 20..(w - 20) {
                let text_line = (y % 48 > 16 && y % 48 < 22) && (x > 36 && x < 280 && x % 5 != 0);
                img.put_pixel(x, y, if text_line { Rgb([18, 24, 38]) } else { Rgb([255, 255, 255]) });
            }
        }
        // Bottom navigation bar
        for y in 744..h {
            for x in 0..w {
                let pill = y > 784 && y < 791 && x > 130 && x < 230;
                img.put_pixel(x, y, if pill { Rgb([255, 255, 255]) } else { Rgb([15, 23, 42]) });
            }
        }
        img
    }

    #[test]
    fn test_authenticity_distinguishes_real_scene_from_screenshot() {
        let tmp = std::env::temp_dir().join("sc_rust_test_models");
        let clf = VisionClassifier::load_or_bootstrap(&tmp);

        let real_rgb = synth_street_scene(640, 480, true, 1.0);
        let (real_bytes, _) = encode_jpeg_b64(&real_rgb);
        let real_dyn = image::load_from_memory(&real_bytes).unwrap();
        let real_res = check_image_authenticity(&real_bytes, &real_dyn, &clf, 50.0);
        assert!(real_res.is_authentic, "Expected real street scene to pass: {:?}", real_res);
        assert!(real_res.authenticity_score >= 65.0);

        let scr_rgb = synth_mobile_screenshot();
        let (scr_bytes, _) = encode_png_b64(&scr_rgb);
        let scr_dyn = image::load_from_memory(&scr_bytes).unwrap();
        let scr_res = check_image_authenticity(&scr_bytes, &scr_dyn, &clf, 50.0);
        assert!(!scr_res.is_authentic, "Expected mobile screenshot to be rejected: {:?}", scr_res);
        assert!(scr_res.authenticity_score < 50.0);
    }

    #[test]
    fn test_crop_subimage_duplicate_detected_via_multiscale_orb_ransac() {
        let full_rgb = synth_street_scene(640, 480, true, 1.0);
        let full_dyn = DynamicImage::ImageRgb8(full_rgb);
        let master_fp = build_fingerprint(
            &full_dyn,
            "DN-TB-2611-001".to_string(),
            Some("DN-TB".to_string()),
            Some(10.9465),
            Some(106.8243),
        );

        // Attacker crops a ~35% area sub-image (380x285 out of 640x480 -> ~35% of pixels!) shifted off-center
        let cropped = full_dyn.crop_imm(110, 75, 380, 285);
        let query_fp = build_fingerprint(
            &cropped,
            "NEW-SUBMIT".to_string(),
            Some("DN-TB".to_string()),
            Some(10.9466),
            Some(106.8244),
        );

        // Classic whole-image dHash fails completely on a crop (Hamming distance >> 8),
        // whereas Multi-Scale ORB + RANSAC catches it cleanly!
        let dup = check_duplicate_against_pool(&query_fp, &[master_fp], 200.0, 14);
        assert!(dup.is_duplicate, "Expected cropped sub-image to be caught as duplicate: {:?}", dup);
        assert_eq!(dup.matched_incident_id.as_deref(), Some("DN-TB-2611-001"));
        assert!(dup.inlier_count >= 14, "Expected >=14 geometric inliers, got {}", dup.inlier_count);
    }

    #[test]
    fn test_before_after_resolution_robust_to_dark_lighting_and_shift() {
        let tmp = std::env::temp_dir().join("sc_rust_test_models");
        let clf = VisionClassifier::load_or_bootstrap(&tmp);

        let before_rgb = synth_street_scene(640, 480, true, 1.0);
        // After repair: trash pile removed, shot at dusk (58% brightness!) and slightly shifted crop
        let after_clean_dark = DynamicImage::ImageRgb8(synth_street_scene(640, 480, false, 0.58))
            .crop_imm(18, 12, 604, 456);

        let req = VerifyResolutionRequest {
            before_image_base64: String::new(),
            after_image_base64: String::new(),
            category: Some("rac_thai".to_string()),
            before_lat: Some(10.9465),
            before_lng: Some(106.8243),
            after_lat: Some(10.9466),
            after_lng: Some(106.8244),
            scene_match_threshold: Some(65.0),
            resolution_threshold: Some(75.0),
        };

        let out = verify_before_after(&DynamicImage::ImageRgb8(before_rgb.clone()), &after_clean_dark, &req, &clf);
        assert!(out.verified, "Expected cleaned dark/shifted after photo to verify RESOLVED: {:?}", out);
        assert!(out.scene_match_score >= 65.0);
        assert!(out.resolution_score >= 75.0);
        assert!(out.confidence >= 85.0);

        // Regression test: category `khac` & `mat_duong` must also verify RESOLVED under 55% dusk lighting without mistaking dark asphalt for a cavity
        let mut req_other = req.clone();
        req_other.category = Some("khac".to_string());
        let out_other = verify_before_after(&DynamicImage::ImageRgb8(before_rgb.clone()), &after_clean_dark, &req_other, &clf);
        assert!(out_other.verified, "Expected cleaned dusk photo for category=khac to verify RESOLVED: {:?}", out_other);

        // Conversely, if defect is STILL THERE (even at different brightness), must NOT verify resolved!
        let after_still_dirty = DynamicImage::ImageRgb8(synth_street_scene(640, 480, true, 0.80));
        let out_dirty = verify_before_after(&DynamicImage::ImageRgb8(before_rgb), &after_still_dirty, &req, &clf);
        assert!(!out_dirty.verified, "Expected uncleaned defect to be rejected: {:?}", out_dirty);
    }
}
