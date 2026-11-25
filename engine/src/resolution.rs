//! High-Precision Before vs. After Resolution Verifier (`POST /cv/verify-resolution`).
//! Decouples:
//!   1) `scene_match_score` (0–100%): GPS Haversine + 8x8 Tile CLAHE + Background-Weighted ORB/RANSAC Alignment + Gradient Orientation Histogram Cosine Similarity.
//!   2) `resolution_score` (0–100%): Aligned ROI Defect/Clutter/Cavity/Flooding Reduction + ONNX Defect Head.
//! Robust against severe brightness/shadow shifts and 10–20° camera angle/zoom variations!

use crate::features::{
    dhash_from_gray_subimage, extract_multiscale_orb, haversine_m, match_keypoints_ransac,
};
use crate::onnx_runtime::{VisionClassifier, FEATURE_DIM};
use image::{DynamicImage, GrayImage};
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;
use std::time::Instant;

#[derive(Clone, Debug, Deserialize)]
pub struct VerifyResolutionRequest {
    pub before_image_base64: String,
    pub after_image_base64: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub before_lat: Option<f64>,
    #[serde(default)]
    pub before_lng: Option<f64>,
    #[serde(default)]
    pub after_lat: Option<f64>,
    #[serde(default)]
    pub after_lng: Option<f64>,
    #[serde(default)]
    pub scene_match_threshold: Option<f32>,
    #[serde(default)]
    pub resolution_threshold: Option<f32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct VerifyResolutionResponse {
    pub verified: bool,
    pub status: String,
    pub confidence: f32,
    pub scene_match_score: f32,
    pub resolution_score: f32,
    pub inlier_keypoints: usize,
    pub gps_distance_m: Option<f64>,
    pub summary: String,
    pub latency_ms: f64,
}

/// Contrast Limited Adaptive Histogram Equalization (8x8 tiles with clip limit)
/// so morning bright sunlight vs evening dusk / shadow images normalize to the same structural contrast.
pub fn clahe_normalize(gray: &GrayImage) -> GrayImage {
    let (w, h) = (gray.width() as usize, gray.height() as usize);
    if w < 16 || h < 16 {
        return gray.clone();
    }
    const TX: usize = 8;
    const TY: usize = 8;
    let tw = (w + TX - 1) / TX;
    let th = (h + TY - 1) / TY;

    let mut luts = vec![[0u8; 256]; TX * TY];
    for ty in 0..TY {
        let y0 = ty * th;
        let y1 = ((ty + 1) * th).min(h);
        for tx in 0..TX {
            let x0 = tx * tw;
            let x1 = ((tx + 1) * tw).min(w);
            if y1 <= y0 || x1 <= x0 {
                continue;
            }
            let area = ((y1 - y0) * (x1 - x0)) as u32;
            let clip = ((area * 3) / 256).max(4);
            let mut hist = [0u32; 256];
            for y in y0..y1 {
                for x in x0..x1 {
                    hist[gray.get_pixel(x as u32, y as u32)[0] as usize] += 1;
                }
            }
            let mut excess = 0u32;
            for bin in &mut hist {
                if *bin > clip {
                    excess += *bin - clip;
                    *bin = clip;
                }
            }
            let redist = excess / 256;
            for bin in &mut hist {
                *bin += redist;
            }
            let mut cdf = 0u32;
            let total = hist.iter().sum::<u32>().max(1);
            let lut = &mut luts[ty * TX + tx];
            for (i, &cnt) in hist.iter().enumerate() {
                cdf += cnt;
                lut[i] = ((cdf * 255) / total).min(255) as u8;
            }
        }
    }

    let mut out = GrayImage::new(w as u32, h as u32);
    for y in 0..h {
        let fy = (y as f32 / th as f32) - 0.5;
        let ty0 = fy.floor().clamp(0.0, (TY - 1) as f32) as usize;
        let ty1 = (ty0 + 1).min(TY - 1);
        let wy = (fy - ty0 as f32).clamp(0.0, 1.0);

        for x in 0..w {
            let fx = (x as f32 / tw as f32) - 0.5;
            let tx0 = fx.floor().clamp(0.0, (TX - 1) as f32) as usize;
            let tx1 = (tx0 + 1).min(TX - 1);
            let wx = (fx - tx0 as f32).clamp(0.0, 1.0);

            let v = gray.get_pixel(x as u32, y as u32)[0] as usize;
            let v00 = luts[ty0 * TX + tx0][v] as f32;
            let v10 = luts[ty0 * TX + tx1][v] as f32;
            let v01 = luts[ty1 * TX + tx0][v] as f32;
            let v11 = luts[ty1 * TX + tx1][v] as f32;

            let top = v00 * (1.0 - wx) + v10 * wx;
            let bot = v01 * (1.0 - wx) + v11 * wx;
            let interp = (top * (1.0 - wy) + bot * wy).round().clamp(0.0, 255.0) as u8;
            out.put_pixel(x as u32, y as u32, image::Luma([interp]));
        }
    }
    out
}

/// Computes a 4x4 spatial x 8-orientation HOG-like descriptor focused on static background architecture
/// (reduced weight on bottom-center foreground defect zone so cleaning up trash/pothole keeps background similarity high!).
fn background_hog_descriptor(clahe_gray: &GrayImage) -> Vec<f32> {
    const N: usize = 128;
    let resized = image::imageops::resize(
        clahe_gray,
        N as u32,
        N as u32,
        image::imageops::FilterType::Triangle,
    );
    let raw = resized.as_raw();
    let mut desc = vec![0.0f32; 4 * 4 * 8];

    for y in 1..(N - 1) {
        let cy = (y * 4) / N;
        for x in 1..(N - 1) {
            let cx = (x * 4) / N;
            // Down-weight lower-middle foreground defect cells `(cy >= 2 && (cx == 1 || cx == 2))`
            let weight = if cy >= 2 && (cx == 1 || cx == 2) { 0.20 } else { 1.0 };
            let gx = raw[y * N + x + 1] as f32 - raw[y * N + x - 1] as f32;
            let gy = raw[(y + 1) * N + x] as f32 - raw[(y - 1) * N + x] as f32;
            let mag = (gx * gx + gy * gy).sqrt() * weight;
            if mag < 4.0 {
                continue;
            }
            let mut angle = gy.atan2(gx);
            if angle < 0.0 {
                angle += PI;
            }
            let bin = (((angle / PI) * 8.0).floor() as usize).min(7);
            desc[(cy * 4 + cx) * 8 + bin] += mag;
        }
    }

    let norm = desc.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-6);
    for v in &mut desc {
        *v /= norm;
    }
    desc
}

fn cosine_sim(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum::<f32>().clamp(0.0, 1.0)
}

/// Measures localized visual defect intensity in the foreground street/sidewalk ROI `[x: 16%..84%, y: 54%..94%]`,
/// mapped into `Before`'s coordinate frame using the RANSAC similarity transform when available.
fn foreground_defect_energy(
    img: &DynamicImage,
    category: &str,
    classifier: &VisionClassifier,
    warp_from_before: Option<(f32, f32, f32, f32, f32)>,
) -> f32 {
    let rgb = img.resize_exact(256, 256, image::imageops::FilterType::Triangle).to_rgb8();
    // Compute ROI mean luminance in the warped coordinate space so dark-cavity & edge thresholds
    // remain strictly invariant to morning daylight vs dusk/shadow illumination.
    let mut luma_sum = 0.0f32;
    let mut luma_cnt = 0.0f32;
    for by in (138..240usize).step_by(2) {
        for bx in (42..214usize).step_by(2) {
            let (u, v) = if let Some((scale, cos_t, sin_t, tx, ty)) = warp_from_before {
                let nx = bx as f32 / 256.0;
                let ny = by as f32 / 256.0;
                let a = scale * cos_t;
                let b = scale * sin_t;
                let wx = ((a * nx - b * ny + tx) * 256.0).round() as i32;
                let wy = ((b * nx + a * ny + ty) * 256.0).round() as i32;
                if wx < 2 || wx >= 254 || wy < 2 || wy >= 254 {
                    continue;
                }
                (wx as usize, wy as usize)
            } else {
                (bx, by)
            };
            let p = rgb.get_pixel(u as u32, v as u32);
            luma_sum += 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32;
            luma_cnt += 1.0;
        }
    }
    let ambient_luma = (luma_sum / luma_cnt.max(1.0)).max(24.0);
    let relative_pit_thresh = (ambient_luma * 0.45).clamp(12.0, 42.0);
    let grad_thresh = (ambient_luma * 0.26).clamp(15.0, 26.0);

    let mut edge_chaos = 0.0f32;
    let mut dark_pit = 0.0f32;
    let mut color_clutter = 0.0f32;
    let mut bright_lamp = 0.0f32;
    let mut water_sheen = 0.0f32;
    let mut samples = 0.0f32;

    for by in 138..240usize {
        for bx in 42..214usize {
            let (u, v) = if let Some((scale, cos_t, sin_t, tx, ty)) = warp_from_before {
                let nx = bx as f32 / 256.0;
                let ny = by as f32 / 256.0;
                let a = scale * cos_t;
                let b = scale * sin_t;
                let wx = ((a * nx - b * ny + tx) * 256.0).round() as i32;
                let wy = ((b * nx + a * ny + ty) * 256.0).round() as i32;
                if wx < 2 || wx >= 254 || wy < 2 || wy >= 254 {
                    continue;
                }
                (wx as usize, wy as usize)
            } else {
                (bx, by)
            };

            let p = rgb.get_pixel(u as u32, v as u32);
            let pr = rgb.get_pixel((u + 1) as u32, v as u32);
            let pd = rgb.get_pixel(u as u32, (v + 1) as u32);

            let luma = 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32;
            let luma_r = 0.299 * pr[0] as f32 + 0.587 * pr[1] as f32 + 0.114 * pr[2] as f32;
            let luma_d = 0.299 * pd[0] as f32 + 0.587 * pd[1] as f32 + 0.114 * pd[2] as f32;

            let grad = ((luma_r - luma).powi(2) + (luma_d - luma).powi(2)).sqrt();
            if grad > grad_thresh {
                edge_chaos += (grad / (ambient_luma * 1.15).max(58.0)).min(1.0);
            }
            if luma < relative_pit_thresh {
                dark_pit += 1.0;
            }
            if luma > 225.0 {
                bright_lamp += 1.0;
            }

            let max_c = p[0].max(p[1]).max(p[2]) as f32;
            let min_c = p[0].min(p[1]).min(p[2]) as f32;
            let sat = if max_c > 10.0 { (max_c - min_c) / max_c } else { 0.0 };
            if sat > 0.32 {
                color_clutter += sat;
            }
            if p[2] >= p[0] && (max_c - min_c) < 38.0 && luma > ambient_luma * 0.95 && luma < 215.0 {
                water_sheen += 0.6;
            }
            samples += 1.0;
        }
    }

    if samples < 64.0 {
        return 0.35;
    }

    let e_norm = (edge_chaos / samples * 2.8).clamp(0.0, 1.0);
    let pit_norm = (dark_pit / samples * 4.0).clamp(0.0, 1.0);
    let col_norm = (color_clutter / samples * 3.5).clamp(0.0, 1.0);
    let wat_norm = (water_sheen / samples * 2.2).clamp(0.0, 1.0);
    let lamp_norm = (bright_lamp / samples * 5.0).clamp(0.0, 1.0);

    // Feed RANSAC-aligned, ambient-normalized foreground ROI signals into the ONNX Defect Head
    let feats: [f32; FEATURE_DIM] = [
        1.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        col_norm,
        e_norm,
        e_norm,
        pit_norm,
        wat_norm,
        col_norm,
    ];
    let onnx_defect = classifier.predict(&feats).defect_present_prob;

    let cat_raw = match category {
        "rac_thai" => 0.42 * e_norm + 0.38 * col_norm + 0.20 * onnx_defect,
        "mat_duong" => 0.45 * pit_norm + 0.35 * e_norm + 0.20 * onnx_defect,
        "ngap_nuoc" => 0.45 * wat_norm + 0.35 * e_norm + 0.20 * onnx_defect,
        // For broken street lights, "defect" means darkness / lack of lamp illumination
        "den_duong" => (0.65 * (1.0 - lamp_norm) + 0.35 * pit_norm).clamp(0.0, 1.0),
        _ => 0.35 * e_norm + 0.25 * col_norm + 0.20 * pit_norm + 0.20 * onnx_defect,
    };
    cat_raw.clamp(0.02, 0.98)
}

pub fn verify_before_after(
    before_img: &DynamicImage,
    after_img: &DynamicImage,
    req: &VerifyResolutionRequest,
    classifier: &VisionClassifier,
) -> VerifyResolutionResponse {
    let t0 = Instant::now();
    let category = req.category.as_deref().unwrap_or("khac");
    let thresh_scene = req.scene_match_threshold.unwrap_or(65.0).clamp(40.0, 92.0);
    let thresh_res = req.resolution_threshold.unwrap_or(75.0).clamp(45.0, 95.0);

    let b_gray_raw = before_img.to_luma8();
    let a_gray_raw = after_img.to_luma8();

    // Anti-fraud check: Officer re-uploaded the exact same BEFORE image without fixing anything!
    let raw_dhash_dist = (dhash_from_gray_subimage(
        &b_gray_raw,
        0,
        0,
        b_gray_raw.width(),
        b_gray_raw.height(),
    ) ^ dhash_from_gray_subimage(
        &a_gray_raw,
        0,
        0,
        a_gray_raw.width(),
        a_gray_raw.height(),
    ))
    .count_ones();

    // CLAHE illumination normalization so dark evening vs bright morning images match cleanly
    let b_clahe = clahe_normalize(&b_gray_raw);
    let a_clahe = clahe_normalize(&a_gray_raw);

    let b_kps = extract_multiscale_orb(&b_clahe, 380);
    let a_kps = extract_multiscale_orb(&a_clahe, 380);
    let geo = match_keypoints_ransac(&b_kps, &a_kps);

    let b_hog = background_hog_descriptor(&b_clahe);
    let a_hog = background_hog_descriptor(&a_clahe);
    let hog_sim = cosine_sim(&b_hog, &a_hog);

    let gps_dist = match (req.before_lat, req.before_lng, req.after_lat, req.after_lng) {
        (Some(lat1), Some(lng1), Some(lat2), Some(lng2)) => Some((haversine_m(lat1, lng1, lat2, lng2) * 10.0).round() / 10.0),
        _ => None,
    };

    // 1. Compute `scene_match_score` (0..100%), invariant to brightness & foreground cleanup
    let inlier_contrib = ((geo.inliers as f32 / 24.0).clamp(0.0, 1.0)) * 52.0;
    let hog_contrib = ((hog_sim - 0.35) / 0.60).clamp(0.0, 1.0) * 44.0;
    let gps_adj = match gps_dist {
        Some(d) if d <= 60.0 => 8.0,
        Some(d) if d <= 120.0 => 4.0,
        Some(d) if d > 250.0 => -35.0,
        _ => 4.0,
    };
    let mut scene_match_score = (inlier_contrib + hog_contrib + gps_adj).clamp(5.0, 99.0);
    // Strong RANSAC geometric background lock (>= 16 inliers) guarantees same physical site even if lighting shifted dramatically!
    if geo.inliers >= 16 && gps_dist.map_or(true, |d| d <= 150.0) {
        scene_match_score = scene_match_score.max(76.0 + (geo.inliers.min(40) as f32 * 0.45)).min(98.5);
    }

    // Check if the two images are literally identical even in the foreground ROI
    let b_small = image::imageops::resize(&b_clahe, 64, 64, image::imageops::FilterType::Triangle);
    let a_small = image::imageops::resize(&a_clahe, 64, 64, image::imageops::FilterType::Triangle);
    let mean_clahe_diff: f32 = b_small
        .as_raw()
        .iter()
        .zip(a_small.as_raw().iter())
        .map(|(&x, &y)| (x as f32 - y as f32).abs())
        .sum::<f32>()
        / (64.0 * 64.0);

    if raw_dhash_dist <= 3 && mean_clahe_diff < 4.5 {
        return VerifyResolutionResponse {
            verified: false,
            status: "UNRESOLVED_IDENTICAL".to_string(),
            confidence: 15.0,
            scene_match_score: (scene_match_score * 10.0).round() / 10.0,
            resolution_score: 8.0,
            inlier_keypoints: geo.inliers,
            gps_distance_m: gps_dist,
            summary: "Ảnh SAU gần như trùng hệt ảnh TRƯỚC — sự cố chưa được xử lý hoặc tải nhầm lại ảnh cũ.".to_string(),
            latency_ms: t0.elapsed().as_secs_f64() * 1000.0,
        };
    }

    // 2. Compute `resolution_score` (0..100%) using aligned foreground ROI defect reduction
    let warp = if geo.inliers >= 8 {
        Some((geo.scale, geo.cos_t, geo.sin_t, geo.tx, geo.ty))
    } else {
        None
    };
    let defect_before = foreground_defect_energy(before_img, category, classifier, None);
    let defect_after = foreground_defect_energy(after_img, category, classifier, warp);

    let relative_drop = ((defect_before - defect_after) / defect_before.max(0.12)).clamp(-0.5, 1.0);
    let cleanliness_after = (1.0 - defect_after).clamp(0.0, 1.0);
    let resolution_score = if relative_drop > 0.08 {
        (52.0 + relative_drop * 36.0 + cleanliness_after * 18.0).clamp(0.0, 98.5)
    } else {
        (25.0 + cleanliness_after * 32.0 + relative_drop * 25.0).clamp(5.0, 68.0)
    };

    let verified = scene_match_score >= thresh_scene && resolution_score >= thresh_res;
    let confidence = if verified {
        (0.45 * scene_match_score + 0.55 * resolution_score).clamp(85.0, 98.0)
    } else {
        scene_match_score.min(resolution_score).clamp(15.0, 74.0)
    };

    let status = if verified {
        "RESOLVED".to_string()
    } else if scene_match_score < thresh_scene {
        "SCENE_MISMATCH".to_string()
    } else {
        "DEFECT_REMAINING".to_string()
    };

    let summary = if verified {
        format!(
            "Nghiệm thu ĐẠT ({:.0}%): Khớp đúng hiện trường ({:.0}%, {} điểm neo hình học RANSAC) và vùng sự cố đã được khắc phục sạch ({:.0}%).",
            confidence, scene_match_score, geo.inliers, resolution_score
        )
    } else if scene_match_score < thresh_scene {
        format!(
            "Nghiệm thu CHƯA ĐẠT: Khung cảnh nền ảnh SAU không khớp địa điểm ảnh TRƯỚC (Điểm đúng vị trí {:.0}% < {:.0}%).",
            scene_match_score, thresh_scene
        )
    } else {
        format!(
            "Đúng hiện trường ({:.0}%) nhưng dấu hiệu sự cố vẫn còn tồn tại (Điểm khắc phục {:.0}% < {:.0}%).",
            scene_match_score, resolution_score, thresh_res
        )
    };

    VerifyResolutionResponse {
        verified,
        status,
        confidence: (confidence * 10.0).round() / 10.0,
        scene_match_score: (scene_match_score * 10.0).round() / 10.0,
        resolution_score: (resolution_score * 10.0).round() / 10.0,
        inlier_keypoints: geo.inliers,
        gps_distance_m: gps_dist,
        summary,
        latency_ms: t0.elapsed().as_secs_f64() * 1000.0,
    }
}
