/**
 * Pure TypeScript ONNX (`ModelProto` / `GraphProto` / `TensorProto`) Runtime cho Node.js Backend.
 * Đọc trực tiếp file nhị phân `models/authenticity_defect_v1.onnx` vào RAM một lần khi khởi động
 * và thực thi đồ thị neural (`MatMul` -> `Add` -> `Relu` -> `MatMul` -> `Add` -> `Sigmoid`) trong < 0.2ms,
 * không tốn RAM cài `onnxruntime-node` gốc (~150MB) trên Render Free Tier.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface OnnxTensor {
  dims: number[];
  data: Float32Array;
}

interface OnnxNode {
  opType: string;
  inputs: string[];
  outputs: string[];
}

export interface OnnxVisionPrediction {
  isScreenshotProb: number;
  isScreenPhotoProb: number;
  defectPresentProb: number;
  onnxModelLoaded: boolean;
}

function readVarint(buf: Buffer, state: { pos: number }): number | null {
  let result = 0;
  let shift = 0;
  while (state.pos < buf.length) {
    const b = buf[state.pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return result >>> 0;
    shift += 7;
    if (shift >= 35) return null;
  }
  return null;
}

function readBytes(buf: Buffer, state: { pos: number }): Buffer | null {
  const len = readVarint(buf, state);
  if (len === null || state.pos + len > buf.length) return null;
  const out = buf.subarray(state.pos, state.pos + len);
  state.pos += len;
  return out;
}

function skipField(buf: Buffer, state: { pos: number }, wireType: number): boolean {
  if (wireType === 0) return readVarint(buf, state) !== null;
  if (wireType === 1) {
    if (state.pos + 8 > buf.length) return false;
    state.pos += 8;
    return true;
  }
  if (wireType === 2) return readBytes(buf, state) !== null;
  if (wireType === 5) {
    if (state.pos + 4 > buf.length) return false;
    state.pos += 4;
    return true;
  }
  return false;
}

function parseTensorProto(buf: Buffer): { name: string; tensor: OnnxTensor } | null {
  const st = { pos: 0 };
  const dims: number[] = [];
  const floatData: number[] = [];
  let rawData: Buffer | null = null;
  let name = '';

  while (st.pos < buf.length) {
    const tag = readVarint(buf, st);
    if (tag === null) return null;
    const field = tag >>> 3;
    const wt = tag & 7;
    if (field === 1 && wt === 0) {
      const d = readVarint(buf, st);
      if (d === null) return null;
      dims.push(d);
    } else if (field === 1 && wt === 2) {
      const packed = readBytes(buf, st);
      if (!packed) return null;
      const pst = { pos: 0 };
      while (pst.pos < packed.length) {
        const d = readVarint(packed, pst);
        if (d === null) return null;
        dims.push(d);
      }
    } else if (field === 4 && wt === 5) {
      if (st.pos + 4 > buf.length) return null;
      floatData.push(buf.readFloatLE(st.pos));
      st.pos += 4;
    } else if (field === 4 && wt === 2) {
      const packed = readBytes(buf, st);
      if (!packed) return null;
      for (let i = 0; i + 4 <= packed.length; i += 4) {
        floatData.push(packed.readFloatLE(i));
      }
    } else if (field === 8 && wt === 2) {
      const n = readBytes(buf, st);
      if (!n) return null;
      name = n.toString('utf8');
    } else if (field === 9 && wt === 2) {
      rawData = readBytes(buf, st);
    } else if (!skipField(buf, st, wt)) {
      return null;
    }
  }

  let data: Float32Array;
  if (floatData.length > 0) {
    data = Float32Array.from(floatData);
  } else if (rawData) {
    const n = Math.floor(rawData.length / 4);
    data = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      data[i] = rawData.readFloatLE(i * 4);
    }
  } else {
    return null;
  }

  return { name, tensor: { dims, data } };
}

function parseNodeProto(buf: Buffer): OnnxNode | null {
  const st = { pos: 0 };
  const inputs: string[] = [];
  const outputs: string[] = [];
  let opType = '';

  while (st.pos < buf.length) {
    const tag = readVarint(buf, st);
    if (tag === null) return null;
    const field = tag >>> 3;
    const wt = tag & 7;
    if (field === 1 && wt === 2) {
      const b = readBytes(buf, st);
      if (!b) return null;
      inputs.push(b.toString('utf8'));
    } else if (field === 2 && wt === 2) {
      const b = readBytes(buf, st);
      if (!b) return null;
      outputs.push(b.toString('utf8'));
    } else if (field === 4 && wt === 2) {
      const b = readBytes(buf, st);
      if (!b) return null;
      opType = b.toString('utf8');
    } else if (!skipField(buf, st, wt)) {
      return null;
    }
  }

  return opType ? { opType, inputs, outputs } : null;
}

class ParsedOnnxGraph {
  constructor(
    readonly initializers: Map<string, OnnxTensor>,
    readonly nodes: OnnxNode[],
  ) {}

  static fromBuffer(buf: Buffer): ParsedOnnxGraph | null {
    const st = { pos: 0 };
    let graphBuf: Buffer | null = null;
    while (st.pos < buf.length) {
      const tag = readVarint(buf, st);
      if (tag === null) return null;
      const field = tag >>> 3;
      const wt = tag & 7;
      if (field === 7 && wt === 2) {
        graphBuf = readBytes(buf, st);
        break;
      } else if (!skipField(buf, st, wt)) {
        return null;
      }
    }
    if (!graphBuf) return null;

    const initializers = new Map<string, OnnxTensor>();
    const nodes: OnnxNode[] = [];
    const gst = { pos: 0 };
    while (gst.pos < graphBuf.length) {
      const tag = readVarint(graphBuf, gst);
      if (tag === null) return null;
      const field = tag >>> 3;
      const wt = tag & 7;
      if (field === 1 && wt === 2) {
        const nb = readBytes(graphBuf, gst);
        if (!nb) return null;
        const node = parseNodeProto(nb);
        if (node) nodes.push(node);
      } else if (field === 5 && wt === 2) {
        const tb = readBytes(graphBuf, gst);
        if (!tb) return null;
        const parsed = parseTensorProto(tb);
        if (parsed?.name) initializers.set(parsed.name, parsed.tensor);
      } else if (!skipField(graphBuf, gst, wt)) {
        return null;
      }
    }

    return nodes.length > 0 && initializers.size > 0
      ? new ParsedOnnxGraph(initializers, nodes)
      : null;
  }

  run(inputName: string, features: Float32Array, outputName = 'probs'): Float32Array | null {
    const env = new Map<string, OnnxTensor>();
    for (const [k, v] of this.initializers) env.set(k, v);
    env.set(inputName, { dims: [1, features.length], data: features });

    for (const node of this.nodes) {
      if (node.opType === 'MatMul') {
        const a = env.get(node.inputs[0]);
        const b = env.get(node.inputs[1]);
        if (!a || !b || a.dims.length < 2 || b.dims.length < 2) return null;
        const m = a.dims[0];
        const k = a.dims[1];
        const n = b.dims[1];
        const out = new Float32Array(m * n);
        for (let r = 0; r < m; r++) {
          for (let c = 0; c < n; c++) {
            let sum = 0;
            for (let i = 0; i < k; i++) sum += a.data[r * k + i] * b.data[i * n + c];
            out[r * n + c] = sum;
          }
        }
        env.set(node.outputs[0], { dims: [m, n], data: out });
      } else if (node.opType === 'Add') {
        const a = env.get(node.inputs[0]);
        const b = env.get(node.inputs[1]);
        if (!a || !b) return null;
        const out = new Float32Array(a.data.length);
        for (let i = 0; i < a.data.length; i++) {
          out[i] = a.data[i] + b.data[i % b.data.length];
        }
        env.set(node.outputs[0], { dims: a.dims, data: out });
      } else if (node.opType === 'Relu') {
        const a = env.get(node.inputs[0]);
        if (!a) return null;
        const out = new Float32Array(a.data.length);
        for (let i = 0; i < a.data.length; i++) out[i] = Math.max(0, a.data[i]);
        env.set(node.outputs[0], { dims: a.dims, data: out });
      } else if (node.opType === 'Sigmoid') {
        const a = env.get(node.inputs[0]);
        if (!a) return null;
        const out = new Float32Array(a.data.length);
        for (let i = 0; i < a.data.length; i++) {
          const z = Math.max(-24, Math.min(24, a.data[i]));
          out[i] = 1 / (1 + Math.exp(-z));
        }
        env.set(node.outputs[0], { dims: a.dims, data: out });
      }
    }

    return env.get(outputName)?.data ?? null;
  }
}

function resolveOnnxPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), 'models/authenticity_defect_v1.onnx'),
    path.resolve(process.cwd(), '../models/authenticity_defect_v1.onnx'),
    path.resolve(__dirname, '../../../models/authenticity_defect_v1.onnx'),
    path.resolve(__dirname, '../../../../models/authenticity_defect_v1.onnx'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

let cachedGraph: ParsedOnnxGraph | null | undefined;

function getLoadedGraph(): ParsedOnnxGraph | null {
  if (cachedGraph !== undefined) return cachedGraph;
  try {
    const p = resolveOnnxPath();
    if (!p) {
      cachedGraph = null;
      return null;
    }
    const buf = fs.readFileSync(p);
    cachedGraph = ParsedOnnxGraph.fromBuffer(buf);
    return cachedGraph;
  } catch {
    cachedGraph = null;
    return null;
  }
}

export function predictWithLocalOnnxModel(features16: Float32Array): OnnxVisionPrediction {
  const graph = getLoadedGraph();
  if (!graph) {
    return {
      isScreenshotProb: 0,
      isScreenPhotoProb: 0,
      defectPresentProb: 0.5,
      onnxModelLoaded: false,
    };
  }
  const out = graph.run('features', features16, 'probs');
  if (!out || out.length < 3) {
    return {
      isScreenshotProb: 0,
      isScreenPhotoProb: 0,
      defectPresentProb: 0.5,
      onnxModelLoaded: false,
    };
  }
  return {
    isScreenshotProb: Math.max(0, Math.min(1, Math.round(out[0] * 1000) / 1000)),
    isScreenPhotoProb: Math.max(0, Math.min(1, Math.round(out[1] * 1000) / 1000)),
    defectPresentProb: Math.max(0, Math.min(1, Math.round(out[2] * 1000) / 1000)),
    onnxModelLoaded: true,
  };
}
