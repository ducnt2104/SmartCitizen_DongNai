//! 3-Tier Screenshot & Screen-Recapture Authenticity Detector:
//! - Tier 1: EXIF Camera Metadata + Exact Screen Resolution Forensics
//! - Tier 2: Top/Bottom 8% UI Status/Nav Bar Edge Density + 2D FFT Moiré Spectral Analysis (`rustfft`)
//! - Tier 3: Local ONNX Neural Vision Classifier (`onnx_runtime`)

use crate::exif_forensics::inspect_exif_and_dimensions;
use crate::onnx_runtime::{VisionClassifier, FEATURE_DIM};
use image::{DynamicImage, GenericImageView};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::{Deserialize, Serialize};
use std::f32::consts::PI;
use std::time::Instant;

#[derive(Clone, Debug, Deserialize)]
pub struct AuthenticityRequest {
    pub image_base64: String,
    #[serde(default)]
    pub screenshot_threshold: Option<f32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AuthenticityResponse {
    pub is_authentic: bool,
    pub authenticity_score: f32,
    pub is_screenshot_prob: f32,
    pub is_screen_photo_prob: f32,
    pub flags: Vec<String>,
    pub reason: String,
    pub onnx_model_loaded: bool,
    pub latency_ms: f64,
}

#[derive(Clone, Debug, Default)]
pub struct SpectralAndUiSignals {
    pub top_bar_ui_score: f32,
    pub bottom_bar_ui_score: f32,
    pub flat_block_ratio: f32,
    pub sharp_bimodal_edge_ratio: f32,
    pub fft_moire_peak_ratio: f32,
    pub high_freq_grid_energy: f32,
    pub color_entropy_norm: f32,
    pub laplacian_sharpness_norm: f32,
    pub center_disorder_score: f32,
    pub dark_cavity_ratio: f32,
    pub water_reflection_ratio: f32,
    pub clutter_blob_density: f32,
}

/// Inspects a horizontal band (e.g., top 8% status bar or bottom 8% navigation bar)
/// for UI screenshot signatures: uniform flat background rows combined with crisp high-contrast glyphs/dividers.
fn analyze_ui_strip(luma: &[u8], w: usize, y_start: usize, y_end: usize) -> f32 {
    if y_end <= y_start || w < 32 {
        return 0.0;
    }
    let rows = y_end - y_start;
    let mut zero_diff_px = 0usize;
    let mut sharp_step_px = 0usize;
    let mut total_pairs = 0usize;
    let mut horizontal_rule_rows = 0usize;

    for y in y_start..y_end {
        let row = &luma[y * w..(y + 1) * w];
        let mut row_zero = 0usize;
        for x in 0..(w - 1) {
            let d = (row[x + 1] as i32 - row[x] as i32).unsigned_abs();
            if d <= 1 {
                zero_diff_px += 1;
                row_zero += 1;
            } else if d >= 55 {
                sharp_step_px += 1;
            }
            total_pairs += 1;
        }
        if row_zero * 100 / (w - 1).max(1) >= 92 {
            horizontal_rule_rows += 1;
        }
    }

    if total_pairs == 0 {
        return 0.0;
    }
    let flat_frac = zero_diff_px as f32 / total_pairs as f32;
    let sharp_frac = sharp_step_px as f32 / total_pairs as f32;
    let rule_frac = horizontal_rule_rows as f32 / rows as f32;

    // UI status/nav bars have BOTH high exact-flat pixel runs (>62%) AND crisp glyph transitions (0.5%..12%)
    let mut score = 0.0f32;
    if flat_frac > 0.62 && sharp_frac > 0.004 && sharp_frac < 0.16 {
        score += ((flat_frac - 0.55) * 2.2).clamp(0.0, 0.75);
        score += (sharp_frac * 8.0).clamp(0.0, 0.35);
    }
    if rule_frac > 0.25 && sharp_frac > 0.003 {
        score += (rule_frac * 0.35).clamp(0.0, 0.30);
    }
    score.clamp(0.0, 1.0)
}

/// Real 2D Fast Fourier Transform (`256x256` Hann-windowed luminance) to detect periodic Moiré interference
/// & pixel-grid aliasing when a phone photographs an LCD/OLED screen.
pub fn compute_2d_fft_moire(luma: &[u8], w: usize, h: usize) -> (f32, f32) {
    const N: usize = 256;
    if w < 32 || h < 32 {
        return (0.0, 0.0);
    }

    let mut hann = [0.0f32; N];
    for (i, v) in hann.iter_mut().enumerate() {
        *v = 0.5 * (1.0 - (2.0 * PI * i as f32 / (N - 1) as f32).cos());
    }

    // Center-crop / resample onto 256x256 grid with 2D Hann window to suppress spectral leakage
    let mut grid = vec![Complex::new(0.0f32, 0.0f32); N * N];
    let mut mean = 0.0f32;
    for gy in 0..N {
        let sy = (gy * h / N).min(h - 1);
        for gx in 0..N {
            let sx = (gx * w / N).min(w - 1);
            let val = luma[sy * w + sx] as f32;
            mean += val;
            grid[gy * N + gx].re = val;
        }
    }
    mean /= (N * N) as f32;
    for gy in 0..N {
        for gx in 0..N {
            let w2d = hann[gy] * hann[gx];
            grid[gy * N + gx].re = (grid[gy * N + gx].re - mean) * w2d;
        }
    }

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N);

    // Row-wise 1D FFTs
    for row in grid.chunks_exact_mut(N) {
        fft.process(row);
    }
    // Transpose -> Column-wise 1D FFTs
    let mut transposed = vec![Complex::new(0.0f32, 0.0f32); N * N];
    for y in 0..N {
        for x in 0..N {
            transposed[x * N + y] = grid[y * N + x];
        }
    }
    for col in transposed.chunks_exact_mut(N) {
        fft.process(col);
    }

    // Analyze shifted 2D log-magnitude spectrum in mid-to-high frequency annulus (r in 22..112),
    // excluding +/-3 bins around cardinal axes (where natural building/horizon lines sit).
    let half = (N / 2) as isize;
    let mut ring_mags = Vec::with_capacity(N * N / 2);
    let mut hf_sum = 0.0f32;
    let mut total_ac_sum = 1e-6f32;

    for u in 0..N {
        let du = ((u as isize + half) % N as isize) - half;
        for v in 0..N {
            let dv = ((v as isize + half) % N as isize) - half;
            let r2 = (du * du + dv * dv) as f32;
            let r = r2.sqrt();
            if r < 6.0 {
                continue;
            }
            let mag = (1.0 + transposed[u * N + v].norm()).ln();
            total_ac_sum += mag;
            if r >= 22.0 && r <= 114.0 {
                hf_sum += mag;
                if du.abs() > 3 && dv.abs() > 3 {
                    ring_mags.push(mag);
                }
            }
        }
    }

    if ring_mags.len() < 64 {
        return (0.0, 0.0);
    }
    ring_mags.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = ring_mags[ring_mags.len() / 2].max(1e-4);
    // Average of top 6 off-axis spectral spikes (periodic Moiré lattice produces conjugate spike pairs)
    let top_k: f32 = ring_mags[ring_mags.len() - 6..].iter().sum::<f32>() / 6.0;
    let peak_to_median = top_k / median;

    // Natural street scenes follow 1/f power law (peak_to_median ~ 1.35..1.85); periodic screen Moiré spikes > 2.15..3.5+
    let moire_norm = ((peak_to_median - 1.92) / 1.15).clamp(0.0, 1.0);
    let hf_ratio = ((hf_sum / total_ac_sum - 0.58) / 0.25).clamp(0.0, 1.0);
    (moire_norm, hf_ratio)
}

pub fn extract_spectral_and_ui_signals(img: &DynamicImage) -> SpectralAndUiSignals {
    let (orig_w, orig_h) = img.dimensions();
    let max_dim = 512u32;
    let working = if orig_w.max(orig_h) > max_dim {
        img.resize(max_dim, max_dim, image::imageops::FilterType::Triangle)
    } else {
        img.clone()
    };
    let rgb = working.to_rgb8();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    if w < 16 || h < 16 {
        return SpectralAndUiSignals::default();
    }

    let mut luma = vec![0u8; w * h];
    let mut color_hist = [0u32; 64]; // 4x4x4 quantized RGB entropy
    let mut dark_cavity_px = 0usize;
    let mut water_reflect_px = 0usize;

    for (idx, px) in rgb.pixels().enumerate() {
        let (r, g, b) = (px[0] as u32, px[1] as u32, px[2] as u32);
        let y = ((77 * r + 150 * g + 29 * b) >> 8) as u8;
        luma[idx] = y;
        let bin = (((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6)) as usize;
        color_hist[bin & 63] += 1;

        let py = idx / w;
        if py >= h / 4 {
            if y < 38 {
                dark_cavity_px += 1;
            }
            // Wet / flooded road reflection signature: cool-gray specular sheen
            let max_c = r.max(g).max(b);
            let min_c = r.min(g).min(b);
            if b >= r && max_c.saturating_sub(min_c) < 35 && y > 95 && y < 215 {
                water_reflect_px += 1;
            }
        }
    }

    let top_h = ((h as f32 * 0.085).round() as usize).clamp(4, h / 3);
    let top_bar_ui_score = analyze_ui_strip(&luma, w, 0, top_h);
    let bottom_bar_ui_score = analyze_ui_strip(&luma, w, h.saturating_sub(top_h), h);

    // 8x8 block flatness + bimodal sharp edge ratio + Laplacian sharpness + ROI disorder
    let mut flat_blocks = 0usize;
    let mut total_blocks = 0usize;
    let mut clutter_blocks = 0usize;
    let mut center_disorder_acc = 0.0f32;
    let mut center_blocks = 0usize;

    for by in (0..h.saturating_sub(8)).step_by(8) {
        for bx in (0..w.saturating_sub(8)).step_by(8) {
            let mut sum = 0.0f32;
            let mut sq = 0.0f32;
            for yy in 0..8 {
                for xx in 0..8 {
                    let v = luma[(by + yy) * w + (bx + xx)] as f32;
                    sum += v;
                    sq += v * v;
                }
            }
            let var = (sq / 64.0) - (sum / 64.0).powi(2);
            if var < 4.5 {
                flat_blocks += 1;
            }
            if by >= h / 4 && by <= (h * 7) / 8 && bx >= w / 6 && bx <= (w * 5) / 6 {
                center_blocks += 1;
                center_disorder_acc += (var.sqrt() / 55.0).clamp(0.0, 1.0);
                if var > 420.0 {
                    clutter_blocks += 1;
                }
            }
            total_blocks += 1;
        }
    }

    let mut bimodal_edges = 0usize;
    let mut zero_grads = 0usize;
    let mut lap_sq = 0.0f64;
    let mut inner_n = 0usize;
    for y in 1..(h - 1) {
        for x in 1..(w - 1) {
            let i = y * w + x;
            let gx = (luma[i + 1] as i32 - luma[i] as i32).unsigned_abs();
            let gy = (luma[i + w] as i32 - luma[i] as i32).unsigned_abs();
            if gx == 0 && gy == 0 {
                zero_grads += 1;
            } else if gx >= 65 || gy >= 65 {
                bimodal_edges += 1;
            }
            let lap = 4 * luma[i] as i32
                - luma[i - 1] as i32
                - luma[i + 1] as i32
                - luma[i - w] as i32
                - luma[i + w] as i32;
            lap_sq += (lap as f64) * (lap as f64);
            inner_n += 1;
        }
    }

    let total_px = (w * h) as f32;
    let mut entropy = 0.0f32;
    for &c in &color_hist {
        if c > 0 {
            let p = c as f32 / total_px;
            entropy -= p * p.log2();
        }
    }
    let color_entropy_norm = (entropy / 5.0).clamp(0.0, 1.0);
    let lap_var = if inner_n > 0 { (lap_sq / inner_n as f64) as f32 } else { 0.0 };
    let laplacian_sharpness_norm = (lap_var / 900.0).clamp(0.0, 1.0);

    let flat_block_ratio = if total_blocks > 0 {
        flat_blocks as f32 / total_blocks as f32
    } else {
        0.0
    };
    let zero_frac = if inner_n > 0 { zero_grads as f32 / inner_n as f32 } else { 0.0 };
    let sharp_frac = if inner_n > 0 { bimodal_edges as f32 / inner_n as f32 } else { 0.0 };
    // Screenshots combine exact zero-gradient UI fills with sharp anti-aliased text steps
    let sharp_bimodal_edge_ratio = if zero_frac > 0.48 {
        (zero_frac * sharp_frac * 22.0).clamp(0.0, 1.0)
    } else {
        (sharp_frac * 3.0).clamp(0.0, 0.35)
    };

    let (fft_moire_peak_ratio, high_freq_grid_energy) = compute_2d_fft_moire(&luma, w, h);
    let lower_px = ((h - h / 4) * w).max(1) as f32;

    SpectralAndUiSignals {
        top_bar_ui_score,
        bottom_bar_ui_score,
        flat_block_ratio,
        sharp_bimodal_edge_ratio,
        fft_moire_peak_ratio,
        high_freq_grid_energy,
        color_entropy_norm,
        laplacian_sharpness_norm,
        center_disorder_score: if center_blocks > 0 {
            (center_disorder_acc / center_blocks as f32).clamp(0.0, 1.0)
        } else {
            0.0
        },
        dark_cavity_ratio: (dark_cavity_px as f32 / lower_px * 3.0).clamp(0.0, 1.0),
        water_reflection_ratio: (water_reflect_px as f32 / lower_px * 2.2).clamp(0.0, 1.0),
        clutter_blob_density: if center_blocks > 0 {
            (clutter_blocks as f32 / center_blocks as f32 * 1.6).clamp(0.0, 1.0)
        } else {
            0.0
        },
    }
}

pub fn check_image_authenticity(
    raw_bytes: &[u8],
    img: &DynamicImage,
    classifier: &VisionClassifier,
    screenshot_threshold: f32,
) -> AuthenticityResponse {
    let t0 = Instant::now();
    let (w, h) = img.dimensions();
    let exif = inspect_exif_and_dimensions(raw_bytes, w, h);
    let sig = extract_spectral_and_ui_signals(img);

    let features: [f32; FEATURE_DIM] = [
        if exif.has_camera_make_model || exif.has_exposure_optics { 1.0 } else { 0.0 },
        if exif.has_screenshot_software { 1.0 } else { 0.0 },
        if exif.exact_screen_resolution { 1.0 } else { 0.0 },
        if exif.is_png_without_exif { 1.0 } else { 0.0 },
        sig.top_bar_ui_score,
        sig.bottom_bar_ui_score,
        sig.flat_block_ratio,
        sig.sharp_bimodal_edge_ratio,
        sig.fft_moire_peak_ratio,
        sig.high_freq_grid_energy,
        sig.color_entropy_norm,
        sig.laplacian_sharpness_norm,
        sig.center_disorder_score,
        sig.dark_cavity_ratio,
        sig.water_reflection_ratio,
        sig.clutter_blob_density,
    ];

    let onnx_pred = classifier.predict(&features);
    let mut flags = Vec::new();
    let mut penalty = 0.0f32;

    if exif.has_screenshot_software {
        flags.push("exif_screenshot_software".to_string());
        penalty += 55.0;
    }
    if exif.exact_screen_resolution && !exif.has_camera_make_model && !exif.has_exposure_optics {
        flags.push("exact_screen_resolution_no_exif".to_string());
        penalty += 26.0;
    } else if !exif.has_camera_make_model && !exif.has_exposure_optics {
        flags.push("missing_camera_exif".to_string());
        penalty += 8.0;
    }
    if exif.is_png_without_exif {
        flags.push("png_digital_capture".to_string());
        penalty += 18.0;
    }
    if sig.top_bar_ui_score >= 0.48 || sig.bottom_bar_ui_score >= 0.48 {
        flags.push("ui_status_or_nav_bar_detected".to_string());
        penalty += 32.0 * sig.top_bar_ui_score.max(sig.bottom_bar_ui_score);
    }
    if sig.flat_block_ratio >= 0.52 {
        flags.push("synthetic_flat_ui_regions".to_string());
        penalty += 28.0 * sig.flat_block_ratio;
    }
    if sig.sharp_bimodal_edge_ratio >= 0.42 {
        flags.push("digital_text_glyph_edges".to_string());
        penalty += 20.0 * sig.sharp_bimodal_edge_ratio;
    }
    if sig.fft_moire_peak_ratio >= 0.50 {
        flags.push("fft_moire_screen_recapture".to_string());
        penalty += 42.0 * sig.fft_moire_peak_ratio;
    }
    if sig.laplacian_sharpness_norm < 0.025 {
        flags.push("severely_blurry".to_string());
        penalty += 24.0;
    }

    // Fuse deterministic 3-tier forensic penalty with ONNX neural probability
    let max_fake_prob = onnx_pred.is_screenshot_prob.max(onnx_pred.is_screen_photo_prob);
    if max_fake_prob >= 0.65 && !flags.contains(&"onnx_screenshot_classifier".to_string()) {
        flags.push("onnx_screenshot_classifier".to_string());
    }

    let camera_bonus = if exif.has_camera_make_model && exif.has_exposure_optics {
        10.0
    } else {
        0.0
    };
    let fused_fake = (0.55 * (penalty / 100.0).clamp(0.0, 1.0) + 0.45 * max_fake_prob).clamp(0.0, 1.0);
    let authenticity_score = ((1.0 - fused_fake) * 100.0 + camera_bonus - penalty * 0.25).clamp(2.0, 99.0);

    let min_authentic_score = screenshot_threshold.clamp(25.0, 85.0);
    let is_authentic = authenticity_score >= min_authentic_score
        && !flags.contains(&"exif_screenshot_software".to_string())
        && !(flags.contains(&"ui_status_or_nav_bar_detected".to_string()) && sig.flat_block_ratio > 0.45);

    let reason = if !is_authentic {
        if flags.iter().any(|f| f.contains("moire")) {
            "Phát hiện vân sóng Moiré phổ FFT 2D — nghi ảnh chụp lại từ màn hình điện thoại/máy tính.".to_string()
        } else if flags.iter().any(|f| f.contains("ui_status") || f.contains("screenshot") || f.contains("flat_ui")) {
            "Phát hiện thanh trạng thái/điều hướng UI, vùng nền phẳng kỹ thuật số hoặc metadata ảnh chụp màn hình.".to_string()
        } else {
            "Điểm xác thực ảnh hiện trường thấp hơn ngưỡng an toàn.".to_string()
        }
    } else {
        "Ảnh đạt chuẩn hiện trường thực tế (vượt qua kiểm định EXIF, tần số FFT 2D và ONNX Classifier).".to_string()
    };

    AuthenticityResponse {
        is_authentic,
        authenticity_score: (authenticity_score * 10.0).round() / 10.0,
        is_screenshot_prob: (onnx_pred.is_screenshot_prob * 1000.0).round() / 1000.0,
        is_screen_photo_prob: (onnx_pred.is_screen_photo_prob * 1000.0).round() / 1000.0,
        flags,
        reason,
        onnx_model_loaded: onnx_pred.onnx_model_loaded,
        latency_ms: t0.elapsed().as_secs_f64() * 1000.0,
    }
}
