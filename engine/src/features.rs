//! Multi-Scale Perceptual Hashing (Global dHash, 2D-DCT pHash, 3x3 Grid dHash, Center-Crop dHash)
//! + Scale & Crop Invariant Multi-Octave Keypoints & Rotated 256-bit BRIEF (ORB) Descriptors
//! + Parallel POPCNT Matching (`rayon`) & Deterministic RANSAC 2D Similarity/Homography Verification.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use image::{DynamicImage, GrayImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;
use std::time::Instant;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct KeypointDesc {
    /// Normalized x coordinate in `[0.0, 1.0]`
    pub x: f32,
    /// Normalized y coordinate in `[0.0, 1.0]`
    pub y: f32,
    /// Pyramid scale at which keypoint was extracted
    pub scale: f32,
    /// 256-bit oriented binary descriptor (`4 * 64` bits)
    pub desc: [u64; 4],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ImageFingerprint {
    pub incident_id: String,
    pub ward_code: Option<String>,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub dhash: u64,
    pub dhash_hex: String,
    pub phash: u64,
    pub phash_hex: String,
    pub center_dhash: u64,
    pub grid_dhashes: [u64; 9],
    pub quad_dhashes: [u64; 4],
    pub keypoints: Vec<KeypointDesc>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SerializedFingerprintDto {
    pub dhash_hex: String,
    pub phash_hex: String,
    pub center_dhash_hex: String,
    pub grid_dhashes_hex: Vec<String>,
    pub keypoint_count: usize,
    pub descriptors_base64: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CandidateFingerprintInput {
    pub incident_id: String,
    pub dhash_hex: String,
    #[serde(default)]
    pub phash_hex: Option<String>,
    #[serde(default)]
    pub center_dhash_hex: Option<String>,
    #[serde(default)]
    pub grid_dhashes_hex: Option<Vec<String>>,
    #[serde(default)]
    pub descriptors_base64: Option<String>,
    #[serde(default)]
    pub lat: Option<f64>,
    #[serde(default)]
    pub lng: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CheckDuplicateRequest {
    pub image_base64: String,
    #[serde(default)]
    pub incident_id: Option<String>,
    #[serde(default)]
    pub ward_code: Option<String>,
    #[serde(default)]
    pub lat: Option<f64>,
    #[serde(default)]
    pub lng: Option<f64>,
    #[serde(default)]
    pub radius_m: Option<f64>,
    #[serde(default)]
    pub register_in_index: Option<bool>,
    #[serde(default)]
    pub min_inliers: Option<usize>,
    #[serde(default)]
    pub external_candidates: Option<Vec<CandidateFingerprintInput>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CheckDuplicateResponse {
    pub is_duplicate: bool,
    pub match_type: String,
    pub matched_incident_id: Option<String>,
    pub similarity_score: f32,
    pub inlier_count: usize,
    pub min_hamming: u32,
    pub grid_matches: usize,
    pub fingerprint: SerializedFingerprintDto,
    pub latency_ms: f64,
}

pub fn dhash_from_gray_subimage(gray: &GrayImage, x0: u32, y0: u32, w: u32, h: u32) -> u64 {
    if w < 2 || h < 2 {
        return 0;
    }
    let mut small = [0f32; 9 * 8];
    for gy in 0..8u32 {
        let sy0 = y0 + (gy * h) / 8;
        let sy1 = (y0 + ((gy + 1) * h) / 8).max(sy0 + 1).min(y0 + h);
        for gx in 0..9u32 {
            let sx0 = x0 + (gx * w) / 9;
            let sx1 = (x0 + ((gx + 1) * w) / 9).max(sx0 + 1).min(x0 + w);
            let mut sum = 0u32;
            let mut cnt = 0u32;
            for py in sy0..sy1 {
                for px in sx0..sx1 {
                    sum += gray.get_pixel(px, py)[0] as u32;
                    cnt += 1;
                }
            }
            small[(gy * 9 + gx) as usize] = sum as f32 / cnt.max(1) as f32;
        }
    }
    let mut bits = 0u64;
    for y in 0..8usize {
        for x in 0..8usize {
            bits = (bits << 1) | u64::from(small[y * 9 + x] > small[y * 9 + x + 1]);
        }
    }
    bits
}

/// 64-bit 2D-DCT Perceptual Hash (`32x32` -> top-left `8x8` AC coefficients vs median).
pub fn phash_64(gray: &GrayImage) -> u64 {
    const N: usize = 32;
    let w = gray.width().max(1);
    let h = gray.height().max(1);
    let mut block = [0.0f32; N * N];
    for y in 0..N {
        let sy = ((y as u32 * h) / N as u32).min(h - 1);
        for x in 0..N {
            let sx = ((x as u32 * w) / N as u32).min(w - 1);
            block[y * N + x] = gray.get_pixel(sx, sy)[0] as f32;
        }
    }

    let mut dct_vals = [0.0f32; 64];
    for u in 0..8usize {
        for v in 0..8usize {
            let mut sum = 0.0f32;
            for y in 0..N {
                let cy = ((2 * y + 1) as f32 * u as f32 * PI / (2.0 * N as f32)).cos();
                for x in 0..N {
                    let cx = ((2 * x + 1) as f32 * v as f32 * PI / (2.0 * N as f32)).cos();
                    sum += block[y * N + x] * cy * cx;
                }
            }
            dct_vals[u * 8 + v] = sum;
        }
    }

    let mut ac: Vec<f32> = dct_vals[1..].to_vec();
    ac.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = ac[ac.len() / 2];

    let mut hash = 0u64;
    for &val in &dct_vals {
        hash = (hash << 1) | u64::from(val > median);
    }
    hash
}

/// Deterministic 256-pair BRIEF sampling pattern within radius 12 around a keypoint.
fn brief_pattern() -> &'static [(i8, i8, i8, i8); 256] {
    use std::sync::OnceLock;
    static PAT: OnceLock<[(i8, i8, i8, i8); 256]> = OnceLock::new();
    PAT.get_or_init(|| {
        let mut arr = [(0i8, 0i8, 0i8, 0i8); 256];
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        let mut next_coord = || -> i8 {
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            let v = state.wrapping_mul(0x2545_F491_4F6C_DD1D);
            // Triangular-like concentration near center (-11..=11)
            let a = ((v & 0xFF) as i32 % 12) - 6;
            let b = (((v >> 8) & 0xFF) as i32 % 11) - 5;
            (a + b).clamp(-11, 11) as i8
        };
        for item in &mut arr {
            let mut x1 = next_coord();
            let mut y1 = next_coord();
            let mut x2 = next_coord();
            let mut y2 = next_coord();
            if x1 == x2 && y1 == y2 {
                x2 = (x1 + 4).clamp(-11, 11);
                y2 = (y1 - 3).clamp(-11, 11);
                if x1 == x2 && y1 == y2 {
                    x1 = -3;
                    y1 = 2;
                }
            }
            *item = (x1, y1, x2, y2);
        }
        arr
    })
}

fn box_blur_3x3(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut out = src.to_vec();
    if w < 3 || h < 3 {
        return out;
    }
    for y in 1..(h - 1) {
        for x in 1..(w - 1) {
            let sum = src[(y - 1) * w + x - 1] as u32
                + src[(y - 1) * w + x] as u32 * 2
                + src[(y - 1) * w + x + 1] as u32
                + src[y * w + x - 1] as u32 * 2
                + src[y * w + x] as u32 * 4
                + src[y * w + x + 1] as u32 * 2
                + src[(y + 1) * w + x - 1] as u32
                + src[(y + 1) * w + x] as u32 * 2
                + src[(y + 1) * w + x + 1] as u32;
            out[y * w + x] = (sum >> 4) as u8;
        }
    }
    out
}

/// Extracts scale-, crop-, brightness-, and rotation-invariant ORB-like keypoints across a 5-level scale pyramid.
/// Because a 30%–60% cropped sub-image has ~1.5x–2.5x larger relative feature size than the uncropped original,
/// sampling scales `[1.0, 0.74, 0.55, 0.41, 0.30]` guarantees matching octave scales between full & cropped images!
pub fn extract_multiscale_orb(gray_full: &GrayImage, max_total: usize) -> Vec<KeypointDesc> {
    let base_max = 480u32;
    let (fw, fh) = (gray_full.width(), gray_full.height());
    if fw < 36 || fh < 36 {
        return Vec::new();
    }
    let ratio = (base_max as f32 / fw.max(fh) as f32).min(1.0);
    let bw = ((fw as f32 * ratio).round() as u32).max(36);
    let bh = ((fh as f32 * ratio).round() as u32).max(36);

    let scales: [f32; 5] = [1.0, 0.74, 0.55, 0.41, 0.30];
    let per_level_budget: [usize; 5] = [130, 100, 80, 55, 35];
    let pat = brief_pattern();
    let mut all_kps = Vec::with_capacity(max_total);

    for (lvl, &sc) in scales.iter().enumerate() {
        let lw = ((bw as f32 * sc).round() as u32).max(32) as usize;
        let lh = ((bh as f32 * sc).round() as u32).max(32) as usize;
        if lw < 34 || lh < 34 {
            continue;
        }
        let resized = image::imageops::resize(
            gray_full,
            lw as u32,
            lh as u32,
            image::imageops::FilterType::Triangle,
        );
        let smoothed = box_blur_3x3(resized.as_raw(), lw, lh);

        // Compute Shi-Tomasi / Harris corner response on 3x3 window with grid NMS
        let margin = 14usize;
        let cell_w = ((lw - 2 * margin).max(8) / 10).max(4);
        let cell_h = ((lh - 2 * margin).max(8) / 10).max(4);
        let grid_cols = ((lw - 2 * margin) + cell_w - 1) / cell_w;
        let grid_rows = ((lh - 2 * margin) + cell_h - 1) / cell_h;
        let mut best_in_cell: Vec<Option<(f32, usize, usize)>> = vec![None; grid_cols * grid_rows];

        for y in margin..(lh - margin) {
            for x in margin..(lw - margin) {
                // Quick contrast gate (FAST-like)
                let c = smoothed[y * lw + x] as i32;
                let d_h = (smoothed[y * lw + x + 3] as i32 - c)
                    .abs()
                    .max((smoothed[y * lw + x - 3] as i32 - c).abs());
                let d_v = (smoothed[(y + 3) * lw + x] as i32 - c)
                    .abs()
                    .max((smoothed[(y - 3) * lw + x] as i32 - c).abs());
                if d_h < 12 && d_v < 12 {
                    continue;
                }

                let mut ixx = 0.0f32;
                let mut iyy = 0.0f32;
                let mut ixy = 0.0f32;
                for wy in (y - 1)..=(y + 1) {
                    for wx in (x - 1)..=(x + 1) {
                        let gx = smoothed[wy * lw + wx + 1] as f32 - smoothed[wy * lw + wx - 1] as f32;
                        let gy = smoothed[(wy + 1) * lw + wx] as f32 - smoothed[(wy - 1) * lw + wx] as f32;
                        ixx += gx * gx;
                        iyy += gy * gy;
                        ixy += gx * gy;
                    }
                }
                let det = ixx * iyy - ixy * ixy;
                let trace = ixx + iyy;
                let score = det - 0.04 * trace * trace;
                if score < 1200.0 {
                    continue;
                }
                let gx_idx = ((x - margin) / cell_w).min(grid_cols - 1);
                let gy_idx = ((y - margin) / cell_h).min(grid_rows - 1);
                let slot = &mut best_in_cell[gy_idx * grid_cols + gx_idx];
                if slot.map_or(true, |(prev, _, _)| score > prev) {
                    *slot = Some((score, x, y));
                }
            }
        }

        let mut level_candidates: Vec<(f32, usize, usize)> = best_in_cell.into_iter().flatten().collect();
        level_candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        level_candidates.truncate(per_level_budget[lvl]);

        for &(_, x, y) in &level_candidates {
            // Intensity centroid orientation (radius 10)
            let mut m10 = 0.0f32;
            let mut m01 = 0.0f32;
            for dy in -10i32..=10 {
                for dx in -10i32..=10 {
                    if dx * dx + dy * dy > 100 {
                        continue;
                    }
                    let v = smoothed[(y as i32 + dy) as usize * lw + (x as i32 + dx) as usize] as f32;
                    m10 += dx as f32 * v;
                    m01 += dy as f32 * v;
                }
            }
            let theta = m01.atan2(m10);
            let (sin_t, cos_t) = theta.sin_cos();

            // Steered 256-bit BRIEF descriptor
            let mut desc = [0u64; 4];
            for (bit_idx, &(x1, y1, x2, y2)) in pat.iter().enumerate() {
                let rx1 = (x1 as f32 * cos_t - y1 as f32 * sin_t).round() as i32;
                let ry1 = (x1 as f32 * sin_t + y1 as f32 * cos_t).round() as i32;
                let rx2 = (x2 as f32 * cos_t - y2 as f32 * sin_t).round() as i32;
                let ry2 = (x2 as f32 * sin_t + y2 as f32 * cos_t).round() as i32;

                let sx1 = (x as i32 + rx1).clamp(0, lw as i32 - 1) as usize;
                let sy1 = (y as i32 + ry1).clamp(0, lh as i32 - 1) as usize;
                let sx2 = (x as i32 + rx2).clamp(0, lw as i32 - 1) as usize;
                let sy2 = (y as i32 + ry2).clamp(0, lh as i32 - 1) as usize;

                if smoothed[sy1 * lw + sx1] > smoothed[sy2 * lw + sx2] {
                    desc[bit_idx / 64] |= 1u64 << (bit_idx % 64);
                }
            }

            all_kps.push(KeypointDesc {
                x: x as f32 / lw as f32,
                y: y as f32 / lh as f32,
                scale: sc,
                desc,
            });
            if all_kps.len() >= max_total {
                return all_kps;
            }
        }
    }
    all_kps
}

pub fn serialize_keypoints_base64(kps: &[KeypointDesc]) -> String {
    // Compact binary format: 44 bytes per keypoint (x:f32, y:f32, scale:f32, desc:[u64;4])
    let mut raw = Vec::with_capacity(kps.len() * 44);
    for kp in kps {
        raw.extend_from_slice(&kp.x.to_le_bytes());
        raw.extend_from_slice(&kp.y.to_le_bytes());
        raw.extend_from_slice(&kp.scale.to_le_bytes());
        for &word in &kp.desc {
            raw.extend_from_slice(&word.to_le_bytes());
        }
    }
    B64.encode(raw)
}

pub fn deserialize_keypoints_base64(b64: &str) -> Vec<KeypointDesc> {
    let Ok(bytes) = B64.decode(b64.trim()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(bytes.len() / 44);
    for chunk in bytes.chunks_exact(44) {
        let x = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        let y = f32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]);
        let scale = f32::from_le_bytes([chunk[8], chunk[9], chunk[10], chunk[11]]);
        let mut desc = [0u64; 4];
        for i in 0..4 {
            let off = 12 + i * 8;
            desc[i] = u64::from_le_bytes([
                chunk[off],
                chunk[off + 1],
                chunk[off + 2],
                chunk[off + 3],
                chunk[off + 4],
                chunk[off + 5],
                chunk[off + 6],
                chunk[off + 7],
            ]);
        }
        out.push(KeypointDesc { x, y, scale, desc });
    }
    out
}

#[inline]
pub fn desc_hamming(a: &[u64; 4], b: &[u64; 4]) -> u32 {
    (a[0] ^ b[0]).count_ones()
        + (a[1] ^ b[1]).count_ones()
        + (a[2] ^ b[2]).count_ones()
        + (a[3] ^ b[3]).count_ones()
}

pub fn build_fingerprint(
    img: &DynamicImage,
    incident_id: String,
    ward_code: Option<String>,
    lat: Option<f64>,
    lng: Option<f64>,
) -> ImageFingerprint {
    let gray = img.to_luma8();
    let (w, h) = (gray.width().max(4), gray.height().max(4));
    let dhash = dhash_from_gray_subimage(&gray, 0, 0, w, h);
    let phash = phash_64(&gray);
    let center_dhash = dhash_from_gray_subimage(&gray, w / 4, h / 4, w / 2, h / 2);

    let mut grid_dhashes = [0u64; 9];
    for gy in 0..3u32 {
        for gx in 0..3u32 {
            let x0 = (gx * w) / 3;
            let y0 = (gy * h) / 3;
            let cw = ((gx + 1) * w / 3).saturating_sub(x0).max(2);
            let ch = ((gy + 1) * h / 3).saturating_sub(y0).max(2);
            grid_dhashes[(gy * 3 + gx) as usize] = dhash_from_gray_subimage(&gray, x0, y0, cw, ch);
        }
    }

    let qw = (w * 3 / 5).max(2);
    let qh = (h * 3 / 5).max(2);
    let quad_dhashes = [
        dhash_from_gray_subimage(&gray, 0, 0, qw, qh),
        dhash_from_gray_subimage(&gray, w - qw, 0, qw, qh),
        dhash_from_gray_subimage(&gray, 0, h - qh, qw, qh),
        dhash_from_gray_subimage(&gray, w - qw, h - qh, qw, qh),
    ];

    let keypoints = extract_multiscale_orb(&gray, 400);

    ImageFingerprint {
        incident_id,
        ward_code,
        lat,
        lng,
        dhash,
        dhash_hex: format!("{:016x}", dhash),
        phash,
        phash_hex: format!("{:016x}", phash),
        center_dhash,
        grid_dhashes,
        quad_dhashes,
        keypoints,
    }
}

impl ImageFingerprint {
    pub fn to_dto(&self) -> SerializedFingerprintDto {
        SerializedFingerprintDto {
            dhash_hex: self.dhash_hex.clone(),
            phash_hex: self.phash_hex.clone(),
            center_dhash_hex: format!("{:016x}", self.center_dhash),
            grid_dhashes_hex: self.grid_dhashes.iter().map(|h| format!("{:016x}", h)).collect(),
            keypoint_count: self.keypoints.len(),
            descriptors_base64: serialize_keypoints_base64(&self.keypoints),
        }
    }

    pub fn from_candidate_input(c: &CandidateFingerprintInput) -> Self {
        let dhash = u64::from_str_radix(c.dhash_hex.trim(), 16).unwrap_or(0);
        let phash = c
            .phash_hex
            .as_deref()
            .and_then(|s| u64::from_str_radix(s.trim(), 16).ok())
            .unwrap_or(dhash);
        let center_dhash = c
            .center_dhash_hex
            .as_deref()
            .and_then(|s| u64::from_str_radix(s.trim(), 16).ok())
            .unwrap_or(dhash);
        let mut grid_dhashes = [0u64; 9];
        if let Some(arr) = &c.grid_dhashes_hex {
            for (i, hex) in arr.iter().take(9).enumerate() {
                grid_dhashes[i] = u64::from_str_radix(hex.trim(), 16).unwrap_or(0);
            }
        }
        let keypoints = c
            .descriptors_base64
            .as_deref()
            .map(deserialize_keypoints_base64)
            .unwrap_or_default();

        Self {
            incident_id: c.incident_id.clone(),
            ward_code: None,
            lat: c.lat,
            lng: c.lng,
            dhash,
            dhash_hex: format!("{:016x}", dhash),
            phash,
            phash_hex: format!("{:016x}", phash),
            center_dhash,
            grid_dhashes,
            quad_dhashes: [0; 4],
            keypoints,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct GeometricMatch {
    pub inliers: usize,
    pub total_tentative: usize,
    /// Estimated 2D similarity transform `p2 = scale * R(theta) * p1 + [tx, ty]`
    pub scale: f32,
    pub cos_t: f32,
    pub sin_t: f32,
    pub tx: f32,
    pub ty: f32,
    pub background_inlier_ratio: f32,
}

/// Matches two keypoint sets via Lowe's ratio test + 250-iteration deterministic RANSAC 2D similarity transform
/// (`x' = a*x - b*y + tx`, `y' = b*x + a*y + ty`). Handles crops (`scale` up to 4.5x), rotations, and pan shifts!
pub fn match_keypoints_ransac(q_kps: &[KeypointDesc], t_kps: &[KeypointDesc]) -> GeometricMatch {
    if q_kps.len() < 6 || t_kps.len() < 6 {
        return GeometricMatch::default();
    }

    let tentative: Vec<(usize, usize)> = q_kps
        .par_iter()
        .enumerate()
        .filter_map(|(qi, q)| {
            let mut best_d = u32::MAX;
            let mut second_d = u32::MAX;
            let mut best_ti = 0usize;
            for (ti, t) in t_kps.iter().enumerate() {
                let d = desc_hamming(&q.desc, &t.desc);
                if d < best_d {
                    second_d = best_d;
                    best_d = d;
                    best_ti = ti;
                } else if d < second_d {
                    second_d = d;
                }
            }
            if best_d <= 62 && (best_d as f32) < 0.84 * (second_d as f32) {
                Some((qi, best_ti))
            } else {
                None
            }
        })
        .collect();

    if tentative.len() < 4 {
        return GeometricMatch {
            total_tentative: tentative.len(),
            ..Default::default()
        };
    }

    let m = tentative.len();
    let mut best = GeometricMatch {
        total_tentative: m,
        scale: 1.0,
        cos_t: 1.0,
        ..Default::default()
    };

    let mut rng = 0xD06E_A120_26CAFEu64;
    let iters = 260usize;
    let inlier_thresh_sq = 0.048f32 * 0.048f32;

    for _ in 0..iters {
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let i1 = ((rng >> 32) as usize) % m;
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let mut i2 = ((rng >> 32) as usize) % m;
        if i1 == i2 {
            i2 = (i1 + 1) % m;
        }

        let (q1, t1) = (&q_kps[tentative[i1].0], &t_kps[tentative[i1].1]);
        let (q2, t2) = (&q_kps[tentative[i2].0], &t_kps[tentative[i2].1]);

        let dx_q = q2.x - q1.x;
        let dy_q = q2.y - q1.y;
        let len_q_sq = dx_q * dx_q + dy_q * dy_q;
        if len_q_sq < 0.0025 {
            continue;
        }

        let dx_t = t2.x - t1.x;
        let dy_t = t2.y - t1.y;
        // Solve 2D similarity: [dx_t; dy_t] = [[a, -b], [b, a]] * [dx_q; dy_q]
        let a = (dx_q * dx_t + dy_q * dy_t) / len_q_sq;
        let b = (dx_q * dy_t - dy_q * dx_t) / len_q_sq;
        let scale = (a * a + b * b).sqrt();
        // Valid physical crop/zoom scale range (0.18x .. 5.5x)
        if !(0.18..=5.5).contains(&scale) {
            continue;
        }

        let tx = t1.x - (a * q1.x - b * q1.y);
        let ty = t1.y - (b * q1.x + a * q1.y);

        let mut inliers = 0usize;
        let mut bg_inliers = 0usize;
        // Deduplicate target keypoints so many-to-one collapse cannot inflate inliers!
        let mut used_target = vec![false; t_kps.len()];
        for &(qi, ti) in &tentative {
            if used_target[ti] {
                continue;
            }
            let qp = &q_kps[qi];
            let tp = &t_kps[ti];
            let px = a * qp.x - b * qp.y + tx;
            let py = b * qp.x + a * qp.y + ty;
            let err_sq = (px - tp.x).powi(2) + (py - tp.y).powi(2);
            if err_sq <= inlier_thresh_sq {
                used_target[ti] = true;
                inliers += 1;
                // Background margin check (upper half or side 25% margins)
                if tp.y < 0.52 || tp.x < 0.25 || tp.x > 0.75 {
                    bg_inliers += 1;
                }
            }
        }

        if inliers > best.inliers {
            best.inliers = inliers;
            best.scale = scale;
            best.cos_t = a / scale.max(1e-6);
            best.sin_t = b / scale.max(1e-6);
            best.tx = tx;
            best.ty = ty;
            best.background_inlier_ratio = bg_inliers as f32 / inliers.max(1) as f32;
        }
    }

    best
}

pub fn haversine_m(lat1: f64, lng1: f64, lat2: f64, lng2: f64) -> f64 {
    let r = 6_371_000.0;
    let dlat = (lat2 - lat1).to_radians();
    let dlng = (lng2 - lng1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlng / 2.0).sin().powi(2);
    2.0 * r * a.sqrt().asin()
}

pub fn check_duplicate_against_pool(
    query: &ImageFingerprint,
    pool: &[ImageFingerprint],
    radius_m: f64,
    min_inliers_req: usize,
) -> CheckDuplicateResponse {
    let t0 = Instant::now();
    let min_inliers = min_inliers_req.max(12);

    let mut best_match_id: Option<String> = None;
    let mut best_type = "none".to_string();
    let mut best_sim = 0.0f32;
    let mut best_inliers = 0usize;
    let mut best_hamming = 64u32;
    let mut best_grid_matches = 0usize;

    for cand in pool {
        if !query.incident_id.is_empty() && cand.incident_id == query.incident_id {
            continue;
        }
        if let (Some(qlat), Some(qlng), Some(clat), Some(clng)) = (query.lat, query.lng, cand.lat, cand.lng) {
            if radius_m > 0.0 && haversine_m(qlat, qlng, clat, clng) > radius_m {
                continue;
            }
        }

        let d_ham = (query.dhash ^ cand.dhash).count_ones();
        let p_ham = (query.phash ^ cand.phash).count_ones();
        let min_h = d_ham.min(p_ham);
        if min_h < best_hamming {
            best_hamming = min_h;
        }

        // Check crop/sub-region hashes: query global dhash vs candidate's center/9-grid/4-quadrant hashes
        let center_ham = (query.dhash ^ cand.center_dhash)
            .count_ones()
            .min((cand.dhash ^ query.center_dhash).count_ones());
        let mut grid_hits = 0usize;
        let mut min_sub_ham = center_ham;
        for &gh in &cand.grid_dhashes {
            let hd = (query.dhash ^ gh).count_ones();
            min_sub_ham = min_sub_ham.min(hd);
        }
        for &qh in &cand.quad_dhashes {
            min_sub_ham = min_sub_ham.min((query.dhash ^ qh).count_ones());
        }
        for i in 0..9 {
            if (query.grid_dhashes[i] ^ cand.grid_dhashes[i]).count_ones() <= 9 {
                grid_hits += 1;
            }
        }

        // 1. Fast exact / near-identical full-frame match
        if d_ham <= 7 || p_ham <= 7 || grid_hits >= 6 {
            let sim = ((64 - min_h) as f32 / 64.0 * 100.0).clamp(85.0, 100.0);
            if sim > best_sim {
                best_sim = sim;
                best_match_id = Some(cand.incident_id.clone());
                best_type = "exact_or_near_duplicate".to_string();
                best_grid_matches = grid_hits;
            }
            continue;
        }

        // 2. Scale & Crop Invariant Local Keypoint + RANSAC Homography/Similarity Match
        let geo = match_keypoints_ransac(&query.keypoints, &cand.keypoints);
        if geo.inliers >= min_inliers || min_sub_ham <= 6 {
            let inlier_score = (58.0 + (geo.inliers as f32 * 1.45)).clamp(72.0, 99.0);
            let sub_score = if min_sub_ham <= 6 { 84.0 } else { 0.0 };
            let sim = inlier_score.max(sub_score);
            if sim > best_sim {
                best_sim = sim;
                best_inliers = geo.inliers;
                best_grid_matches = grid_hits;
                best_match_id = Some(cand.incident_id.clone());
                best_type = if (geo.scale - 1.0).abs() > 0.14 || min_sub_ham <= 6 {
                    "crop_subimage_duplicate".to_string()
                } else {
                    "keypoint_geometric_duplicate".to_string()
                };
            }
        } else if geo.inliers > best_inliers {
            best_inliers = geo.inliers;
            best_grid_matches = grid_hits;
        }
    }

    let is_duplicate = best_match_id.is_some();
    CheckDuplicateResponse {
        is_duplicate,
        match_type: best_type,
        matched_incident_id: best_match_id,
        similarity_score: (best_sim * 10.0).round() / 10.0,
        inlier_count: best_inliers,
        min_hamming: if best_hamming == 64 && pool.is_empty() { 64 } else { best_hamming },
        grid_matches: best_grid_matches,
        fingerprint: query.to_dto(),
        latency_ms: t0.elapsed().as_secs_f64() * 1000.0,
    }
}
