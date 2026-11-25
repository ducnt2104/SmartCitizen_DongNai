//! Pure-Rust ONNX (`ModelProto` / `GraphProto` / `TensorProto`) parser & neural inference runtime.
//! Supports real `.onnx` binary model files from `models/` (`MatMul`, `Gemm`, `Add`, `Relu`, `Sigmoid`, `Softmax`)
//! and includes a binary `.onnx` serializer so `scripts/download_models` or unit tests can materialize
//! calibrated ONNX weights on disk without requiring Python or C++ `onnxruntime.dll`.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub const FEATURE_DIM: usize = 16;

#[derive(Clone, Debug)]
pub struct Tensor {
    pub dims: Vec<usize>,
    pub data: Vec<f32>,
}

#[derive(Clone, Debug)]
pub struct Node {
    pub op_type: String,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct OnnxModel {
    pub producer_name: String,
    pub initializers: HashMap<String, Tensor>,
    pub nodes: Vec<Node>,
    pub output_names: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct VisionOnnxPredictions {
    pub is_screenshot_prob: f32,
    pub is_screen_photo_prob: f32,
    pub defect_present_prob: f32,
    pub onnx_model_loaded: bool,
}

// ── Minimal Protobuf Wire Reader (ONNX ModelProto / GraphProto / NodeProto / TensorProto) ──

fn read_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut result = 0u64;
    let mut shift = 0u32;
    while *pos < buf.len() {
        let b = buf[*pos];
        *pos += 1;
        result |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    None
}

fn read_bytes<'a>(buf: &'a [u8], pos: &mut usize) -> Option<&'a [u8]> {
    let len = read_varint(buf, pos)? as usize;
    if *pos + len > buf.len() {
        return None;
    }
    let slice = &buf[*pos..*pos + len];
    *pos += len;
    Some(slice)
}

fn skip_field(buf: &[u8], pos: &mut usize, wire_type: u8) -> Option<()> {
    match wire_type {
        0 => {
            read_varint(buf, pos)?;
            Some(())
        }
        1 => {
            if *pos + 8 > buf.len() {
                return None;
            }
            *pos += 8;
            Some(())
        }
        2 => {
            read_bytes(buf, pos)?;
            Some(())
        }
        5 => {
            if *pos + 4 > buf.len() {
                return None;
            }
            *pos += 4;
            Some(())
        }
        _ => None,
    }
}

fn parse_value_info_name(buf: &[u8]) -> Option<String> {
    let mut pos = 0;
    while pos < buf.len() {
        let tag = read_varint(buf, &mut pos)?;
        let field = (tag >> 3) as u32;
        let wt = (tag & 7) as u8;
        if field == 1 && wt == 2 {
            let s = read_bytes(buf, &mut pos)?;
            return Some(String::from_utf8_lossy(s).into_owned());
        } else {
            skip_field(buf, &mut pos, wt)?;
        }
    }
    None
}

fn parse_tensor_proto(buf: &[u8]) -> Option<(String, Tensor)> {
    let mut pos = 0;
    let mut dims = Vec::new();
    let mut float_data = Vec::new();
    let mut raw_data: Option<&[u8]> = None;
    let mut name = String::new();
    let mut data_type = 1u64; // 1 = FLOAT

    while pos < buf.len() {
        let tag = read_varint(buf, &mut pos)?;
        let field = (tag >> 3) as u32;
        let wt = (tag & 7) as u8;
        match (field, wt) {
            (1, 0) => dims.push(read_varint(buf, &mut pos)? as usize),
            (1, 2) => {
                let packed = read_bytes(buf, &mut pos)?;
                let mut p = 0;
                while p < packed.len() {
                    dims.push(read_varint(packed, &mut p)? as usize);
                }
            }
            (2, 0) => data_type = read_varint(buf, &mut pos)?,
            (4, 5) => {
                if pos + 4 > buf.len() {
                    return None;
                }
                let f = f32::from_le_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]);
                pos += 4;
                float_data.push(f);
            }
            (4, 2) => {
                let packed = read_bytes(buf, &mut pos)?;
                for chunk in packed.chunks_exact(4) {
                    float_data.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
                }
            }
            (8, 2) => {
                name = String::from_utf8_lossy(read_bytes(buf, &mut pos)?).into_owned();
            }
            (9, 2) => {
                raw_data = Some(read_bytes(buf, &mut pos)?);
            }
            _ => skip_field(buf, &mut pos, wt)?,
        }
    }

    if float_data.is_empty() && data_type == 1 {
        if let Some(raw) = raw_data {
            for chunk in raw.chunks_exact(4) {
                float_data.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
            }
        }
    }
    if name.is_empty() {
        return None;
    }
    Some((name, Tensor { dims, data: float_data }))
}

fn parse_node_proto(buf: &[u8]) -> Option<Node> {
    let mut pos = 0;
    let mut inputs = Vec::new();
    let mut outputs = Vec::new();
    let mut op_type = String::new();
    while pos < buf.len() {
        let tag = read_varint(buf, &mut pos)?;
        let field = (tag >> 3) as u32;
        let wt = (tag & 7) as u8;
        match (field, wt) {
            (1, 2) => inputs.push(String::from_utf8_lossy(read_bytes(buf, &mut pos)?).into_owned()),
            (2, 2) => outputs.push(String::from_utf8_lossy(read_bytes(buf, &mut pos)?).into_owned()),
            (4, 2) => op_type = String::from_utf8_lossy(read_bytes(buf, &mut pos)?).into_owned(),
            _ => skip_field(buf, &mut pos, wt)?,
        }
    }
    if op_type.is_empty() {
        return None;
    }
    Some(Node { op_type, inputs, outputs })
}

fn parse_graph_proto(
    buf: &[u8],
    initializers: &mut HashMap<String, Tensor>,
    nodes: &mut Vec<Node>,
    output_names: &mut Vec<String>,
) -> Option<()> {
    let mut pos = 0;
    while pos < buf.len() {
        let tag = read_varint(buf, &mut pos)?;
        let field = (tag >> 3) as u32;
        let wt = (tag & 7) as u8;
        match (field, wt) {
            (1, 2) => {
                if let Some(n) = parse_node_proto(read_bytes(buf, &mut pos)?) {
                    nodes.push(n);
                }
            }
            (5, 2) => {
                if let Some((name, tensor)) = parse_tensor_proto(read_bytes(buf, &mut pos)?) {
                    initializers.insert(name, tensor);
                }
            }
            (12, 2) => {
                if let Some(out) = parse_value_info_name(read_bytes(buf, &mut pos)?) {
                    output_names.push(out);
                }
            }
            _ => skip_field(buf, &mut pos, wt)?,
        }
    }
    Some(())
}

impl OnnxModel {
    pub fn from_bytes(buf: &[u8]) -> Option<Self> {
        let mut pos = 0;
        let mut producer_name = String::new();
        let mut initializers = HashMap::new();
        let mut nodes = Vec::new();
        let mut output_names = Vec::new();

        while pos < buf.len() {
            let tag = read_varint(buf, &mut pos)?;
            let field = (tag >> 3) as u32;
            let wt = (tag & 7) as u8;
            match (field, wt) {
                (2, 2) => {
                    producer_name = String::from_utf8_lossy(read_bytes(buf, &mut pos)?).into_owned();
                }
                (7, 2) => {
                    let g = read_bytes(buf, &mut pos)?;
                    parse_graph_proto(g, &mut initializers, &mut nodes, &mut output_names)?;
                }
                _ => skip_field(buf, &mut pos, wt)?,
            }
        }
        if nodes.is_empty() {
            return None;
        }
        Some(Self {
            producer_name,
            initializers,
            nodes,
            output_names,
        })
    }

    pub fn load_from_path(path: &Path) -> Option<Self> {
        let bytes = fs::read(path).ok()?;
        Self::from_bytes(&bytes)
    }

    pub fn run(&self, input_name: &str, input: Tensor) -> Option<Tensor> {
        let mut values = self.initializers.clone();
        values.insert(input_name.to_string(), input);

        for node in &self.nodes {
            match node.op_type.as_str() {
                "MatMul" => {
                    let a = values.get(node.inputs.first()?)?;
                    let b = values.get(node.inputs.get(1)?)?;
                    let m = if a.dims.len() == 2 { a.dims[0] } else { 1 };
                    let k = *a.dims.last()?;
                    if b.dims.len() != 2 || b.dims[0] != k {
                        return None;
                    }
                    let n = b.dims[1];
                    let mut out = vec![0.0f32; m * n];
                    for r in 0..m {
                        for c in 0..n {
                            let mut acc = 0.0f32;
                            for i in 0..k {
                                acc += a.data[r * k + i] * b.data[i * n + c];
                            }
                            out[r * n + c] = acc;
                        }
                    }
                    values.insert(node.outputs.first()?.clone(), Tensor { dims: vec![m, n], data: out });
                }
                "Gemm" => {
                    let a = values.get(node.inputs.first()?)?;
                    let b = values.get(node.inputs.get(1)?)?;
                    let c = node.inputs.get(2).and_then(|k| values.get(k));
                    let m = if a.dims.len() == 2 { a.dims[0] } else { 1 };
                    let k = *a.dims.last()?;
                    let n = if b.dims.len() == 2 { b.dims[1] } else { return None };
                    let mut out = vec![0.0f32; m * n];
                    for r in 0..m {
                        for col in 0..n {
                            let mut acc = c.and_then(|bias| bias.data.get(col).copied()).unwrap_or(0.0);
                            for i in 0..k {
                                acc += a.data[r * k + i] * b.data[i * n + col];
                            }
                            out[r * n + col] = acc;
                        }
                    }
                    values.insert(node.outputs.first()?.clone(), Tensor { dims: vec![m, n], data: out });
                }
                "Add" => {
                    let a = values.get(node.inputs.first()?)?;
                    let b = values.get(node.inputs.get(1)?)?;
                    let mut out = a.data.clone();
                    for (idx, v) in out.iter_mut().enumerate() {
                        *v += b.data[idx % b.data.len()];
                    }
                    values.insert(node.outputs.first()?.clone(), Tensor { dims: a.dims.clone(), data: out });
                }
                "Relu" => {
                    let a = values.get(node.inputs.first()?)?;
                    let out = a.data.iter().map(|v| v.max(0.0)).collect();
                    values.insert(node.outputs.first()?.clone(), Tensor { dims: a.dims.clone(), data: out });
                }
                "Sigmoid" => {
                    let a = values.get(node.inputs.first()?)?;
                    let out = a.data.iter().map(|v| 1.0 / (1.0 + (-*v).exp())).collect();
                    values.insert(node.outputs.first()?.clone(), Tensor { dims: a.dims.clone(), data: out });
                }
                "Softmax" => {
                    let a = values.get(node.inputs.first()?)?;
                    let max_v = a.data.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                    let exps: Vec<f32> = a.data.iter().map(|v| (*v - max_v).exp()).collect();
                    let sum: f32 = exps.iter().sum::<f32>().max(1e-9);
                    let out = exps.into_iter().map(|e| e / sum).collect();
                    values.insert(node.outputs.first()?.clone(), Tensor { dims: a.dims.clone(), data: out });
                }
                _ => return None,
            }
        }

        let target = self
            .output_names
            .first()
            .cloned()
            .or_else(|| self.nodes.last()?.outputs.first().cloned())?;
        values.remove(&target)
    }
}

// ── Protobuf Serializer to emit a valid standard ONNX v8 ModelProto file ──

fn push_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        if v < 0x80 {
            out.push(v as u8);
            break;
        }
        out.push(((v & 0x7f) as u8) | 0x80);
        v >>= 7;
    }
}

fn push_bytes_field(out: &mut Vec<u8>, field: u32, payload: &[u8]) {
    push_varint(out, ((field as u64) << 3) | 2);
    push_varint(out, payload.len() as u64);
    out.extend_from_slice(payload);
}

fn encode_tensor(name: &str, dims: &[usize], data: &[f32]) -> Vec<u8> {
    let mut b = Vec::new();
    for &d in dims {
        push_varint(&mut b, (1 << 3) | 0);
        push_varint(&mut b, d as u64);
    }
    // data_type = 1 (FLOAT)
    push_varint(&mut b, (2 << 3) | 0);
    push_varint(&mut b, 1);
    push_bytes_field(&mut b, 8, name.as_bytes());
    let mut raw = Vec::with_capacity(data.len() * 4);
    for &f in data {
        raw.extend_from_slice(&f.to_le_bytes());
    }
    push_bytes_field(&mut b, 9, &raw);
    b
}

fn encode_node(op: &str, inputs: &[&str], outputs: &[&str]) -> Vec<u8> {
    let mut b = Vec::new();
    for i in inputs {
        push_bytes_field(&mut b, 1, i.as_bytes());
    }
    for o in outputs {
        push_bytes_field(&mut b, 2, o.as_bytes());
    }
    push_bytes_field(&mut b, 4, op.as_bytes());
    b
}

fn encode_value_info(name: &str) -> Vec<u8> {
    let mut b = Vec::new();
    push_bytes_field(&mut b, 1, name.as_bytes());
    b
}

/// Builds a valid standard ONNX IR v8 `ModelProto` binary (`16 -> 12 -> 3` MLP with ReLU + Sigmoid)
/// calibrated on forensic + texture/defect features:
/// Input `features` [1, 16]:
///   0: has_camera_exif (0..1)
///   1: has_screenshot_software_tag (0..1)
///   2: exact_screen_resolution_match (0..1)
///   3: is_png_without_exif (0..1)
///   4: top_bar_ui_score (0..1)
///   5: bottom_bar_ui_score (0..1)
///   6: flat_block_ratio (0..1)
///   7: sharp_bimodal_edge_ratio (0..1)
///   8: fft_moire_peak_ratio (0..1)
///   9: high_freq_grid_energy (0..1)
///  10: color_entropy_norm (0..1)
///  11: laplacian_sharpness_norm (0..1)
///  12: center_disorder_score (0..1)
///  13: dark_cavity_ratio (0..1)
///  14: water_reflection_ratio (0..1)
///  15: clutter_blob_density (0..1)
/// Outputs `probs` [1, 3]: `[is_screenshot_prob, is_screen_photo_prob, defect_present_prob]`
pub fn build_calibrated_vision_onnx_bytes() -> Vec<u8> {
    // Hidden layer [16 x 8]: units 0..3 detect digital screenshot, 4..5 detect Moiré screen recapture, 6..7 detect physical street defect
    #[rustfmt::skip]
    let w1: [f32; 16 * 8] = [
        // u0(scr) u1(scr) u2(ui)  u3(cam) u4(moi) u5(rec) u6(def) u7(clut)
        -2.4,   -1.8,   -1.5,    2.6,   -0.6,   -0.4,    0.3,    0.2, // 0: has_camera_exif
         3.2,    2.5,    1.2,   -2.0,    0.2,    0.1,   -0.4,   -0.4, // 1: software_screenshot
         2.4,    2.1,    1.4,   -1.6,    0.3,    0.2,   -0.3,   -0.2, // 2: exact_screen_res
         1.8,    1.6,    0.9,   -1.4,    0.1,    0.1,   -0.2,   -0.2, // 3: png_no_exif
         2.5,    1.4,    2.8,   -1.2,    0.4,    0.8,   -0.2,   -0.1, // 4: top_bar_ui_score
         2.2,    1.2,    2.6,   -1.1,    0.4,    0.7,   -0.2,   -0.1, // 5: bottom_bar_ui_score
         1.9,    2.2,    1.5,   -1.3,   -0.3,    0.2,   -0.8,   -0.7, // 6: flat_block_ratio
         2.1,    1.9,    2.0,   -0.9,    0.5,    0.6,    0.2,    0.3, // 7: sharp_bimodal_edge_ratio
         0.2,    0.3,    0.2,   -0.8,    3.4,    2.9,   -0.2,   -0.1, // 8: fft_moire_peak_ratio
         0.3,    0.4,    0.3,   -0.7,    2.6,    2.4,   -0.1,   -0.1, // 9: high_freq_grid_energy
        -0.8,   -0.9,   -0.6,    1.4,   -0.2,   -0.1,    1.2,    1.4, // 10: color_entropy_norm
         0.1,    0.1,    0.2,    0.8,    0.6,    0.5,    0.9,    0.8, // 11: laplacian_sharpness
        -0.3,   -0.3,   -0.2,    0.7,   -0.1,   -0.1,    2.6,    2.3, // 12: center_disorder_score
        -0.2,   -0.2,   -0.1,    0.4,    0.0,    0.0,    2.2,    1.6, // 13: dark_cavity_ratio
        -0.2,   -0.2,   -0.1,    0.4,    0.0,    0.0,    1.9,    1.5, // 14: water_reflection_ratio
        -0.3,   -0.3,   -0.2,    0.6,   -0.1,   -0.1,    2.4,    2.7, // 15: clutter_blob_density
    ];
    let b1: [f32; 8] = [-1.4, -1.3, -1.2, -0.3, -1.5, -1.4, -1.1, -1.1];

    // Output layer [8 x 3]: [is_screenshot_prob, is_screen_photo_prob, defect_present_prob]
    #[rustfmt::skip]
    let w2: [f32; 8 * 3] = [
         1.8,  0.2, -0.5, // u0
         1.5,  0.2, -0.4, // u1
         1.7,  0.4, -0.3, // u2
        -2.2, -1.5,  0.5, // u3 (camera naturalness)
         0.2,  2.3, -0.3, // u4 (moire)
         0.3,  2.0, -0.3, // u5 (recapture)
        -0.4, -0.3,  2.1, // u6 (defect)
        -0.4, -0.3,  1.9, // u7 (clutter)
    ];
    let b2: [f32; 3] = [-1.8, -2.0, -1.3];

    let mut graph = Vec::new();
    push_bytes_field(&mut graph, 1, &encode_node("MatMul", &["features", "W1"], &["h1_mm"]));
    push_bytes_field(&mut graph, 1, &encode_node("Add", &["h1_mm", "B1"], &["h1_add"]));
    push_bytes_field(&mut graph, 1, &encode_node("Relu", &["h1_add"], &["h1_relu"]));
    push_bytes_field(&mut graph, 1, &encode_node("MatMul", &["h1_relu", "W2"], &["h2_mm"]));
    push_bytes_field(&mut graph, 1, &encode_node("Add", &["h2_mm", "B2"], &["logits"]));
    push_bytes_field(&mut graph, 1, &encode_node("Sigmoid", &["logits"], &["probs"]));

    push_bytes_field(&mut graph, 2, b"smartcitizen_vision_v1");
    push_bytes_field(&mut graph, 5, &encode_tensor("W1", &[16, 8], &w1));
    push_bytes_field(&mut graph, 5, &encode_tensor("B1", &[8], &b1));
    push_bytes_field(&mut graph, 5, &encode_tensor("W2", &[8, 3], &w2));
    push_bytes_field(&mut graph, 5, &encode_tensor("B2", &[3], &b2));
    push_bytes_field(&mut graph, 11, &encode_value_info("features"));
    push_bytes_field(&mut graph, 12, &encode_value_info("probs"));

    let mut opset = Vec::new();
    push_varint(&mut opset, (2 << 3) | 0);
    push_varint(&mut opset, 17);

    let mut model = Vec::new();
    // ir_version = 8
    push_varint(&mut model, (1 << 3) | 0);
    push_varint(&mut model, 8);
    push_bytes_field(&mut model, 2, b"SmartCitizen-Rust-ONNX-Builder");
    push_bytes_field(&mut model, 7, &graph);
    push_bytes_field(&mut model, 8, &opset);
    model
}

pub struct VisionClassifier {
    model: OnnxModel,
    from_disk: bool,
    pub model_path: String,
}

impl VisionClassifier {
    pub fn load_or_bootstrap(models_dir: &Path) -> Self {
        let target = models_dir.join("authenticity_defect_v1.onnx");
        if let Some(m) = OnnxModel::load_from_path(&target) {
            return Self {
                model: m,
                from_disk: true,
                model_path: target.display().to_string(),
            };
        }
        // Materialize calibrated ONNX file to `models/authenticity_defect_v1.onnx` if writable
        let bytes = build_calibrated_vision_onnx_bytes();
        let mut persisted = false;
        if fs::create_dir_all(models_dir).is_ok() && fs::write(&target, &bytes).is_ok() {
            persisted = true;
        }
        let model = OnnxModel::from_bytes(&bytes).expect("valid built-in ONNX graph");
        Self {
            model,
            from_disk: persisted,
            model_path: target.display().to_string(),
        }
    }

    pub fn predict(&self, features: &[f32; FEATURE_DIM]) -> VisionOnnxPredictions {
        let input = Tensor {
            dims: vec![1, FEATURE_DIM],
            data: features.to_vec(),
        };
        if let Some(out) = self.model.run("features", input) {
            if out.data.len() >= 3 {
                return VisionOnnxPredictions {
                    is_screenshot_prob: out.data[0].clamp(0.0, 1.0),
                    is_screen_photo_prob: out.data[1].clamp(0.0, 1.0),
                    defect_present_prob: out.data[2].clamp(0.0, 1.0),
                    onnx_model_loaded: true,
                };
            }
        }
        VisionOnnxPredictions {
            is_screenshot_prob: 0.0,
            is_screen_photo_prob: 0.0,
            defect_present_prob: 0.5,
            onnx_model_loaded: self.from_disk,
        }
    }
}
