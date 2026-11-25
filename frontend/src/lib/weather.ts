import { api } from './api';

export type WeatherKind = 'sun' | 'partlyCloudy' | 'cloud' | 'rain' | 'heavyRain' | 'storm';

export interface HourlyPoint {
  timeIso: string;
  hourLabel: string;
  temp: number;
  rainProb: number;
  rainMm: number;
  isDay: boolean;
  kind: WeatherKind;
}

export interface DailyPoint {
  dateIso: string;
  dayLabel: string;
  tempMin: number;
  tempMax: number;
  rainProbMax: number;
  rainSum: number;
  uvMax: number;
  kind: WeatherKind;
  summaryVi: string;
  summaryEn: string;
}

export interface DongNaiWeather {
  source: 'live';
  providerLabel: string;
  fetchedAt: string;
  observedAt: string;
  timezone: string;
  lat: number;
  lng: number;
  temp: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  windGusts: number;
  pressureHpa: number;
  rainNow: number;
  rainProbNow: number;
  cloudCover: number;
  uvIndex: number;
  isDay: boolean;
  kind: WeatherKind;
  conditionVi: string;
  conditionEn: string;
  tempHigh: number;
  tempLow: number;
  sunrise: string;
  sunset: string;
  hourly: HourlyPoint[];
  daily: DailyPoint[];
}

function mapWmoCode(code: number, isDay = true): { kind: WeatherKind; vi: string; en: string } {
  if (code === 0) {
    return {
      kind: 'sun',
      vi: isDay ? 'Trời quang, nắng ráo' : 'Trời quang, ít mây',
      en: isDay ? 'Clear & sunny' : 'Clear night',
    };
  }
  if (code <= 2) {
    return {
      kind: 'partlyCloudy',
      vi: isDay ? 'Ít mây, nắng nhẹ' : 'Ít mây',
      en: 'Partly cloudy',
    };
  }
  if (code === 3) return { kind: 'cloud', vi: 'Nhiều mây, âm u', en: 'Overcast' };
  if (code === 45 || code === 48) return { kind: 'cloud', vi: 'Có sương mù nhẹ', en: 'Foggy' };
  if ((code >= 51 && code <= 57)) {
    return { kind: 'rain', vi: 'Mưa phùn nhẹ', en: 'Light drizzle' };
  }
  if ((code >= 61 && code <= 63) || (code >= 80 && code <= 81)) {
    return { kind: 'rain', vi: 'Có mưa rào rải rác', en: 'Scattered showers' };
  }
  if (code === 65 || code === 67 || code === 82) {
    return { kind: 'heavyRain', vi: 'Mưa vừa đến mưa to', en: 'Moderate to heavy rain' };
  }
  if (code >= 95) {
    return { kind: 'storm', vi: 'Mưa dông, có khả năng gió giật', en: 'Thunderstorm & gusty winds' };
  }
  return { kind: 'partlyCloudy', vi: 'Mây thay đổi', en: 'Partly cloudy' };
}

function formatHourLabel(isoLocal: string): string {
  const m = /T(\d{2}:\d{2})/.exec(isoLocal);
  return m ? m[1] : isoLocal.slice(11, 16);
}

function formatDayLabel(isoDate: string, idx: number, lang: 'vi' | 'en'): string {
  if (idx === 0) return lang === 'vi' ? 'Hôm nay' : 'Today';
  if (idx === 1) return lang === 'vi' ? 'Ngày mai' : 'Tomorrow';
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-US', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  });
}

interface OpenMeteoPayload {
  latitude?: number;
  longitude?: number;
  timezone?: string;
  utc_offset_seconds?: number;
  current?: {
    time?: string;
    temperature_2m?: number;
    relative_humidity_2m?: number;
    apparent_temperature?: number;
    is_day?: number;
    precipitation?: number;
    rain?: number;
    weather_code?: number;
    cloud_cover?: number;
    wind_speed_10m?: number;
    wind_gusts_10m?: number;
    surface_pressure?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    relative_humidity_2m?: number[];
    precipitation_probability?: number[];
    precipitation?: number[];
    weather_code?: number[];
    uv_index?: number[];
    is_day?: number[];
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
    precipitation_probability_max?: number[];
    uv_index_max?: number[];
    sunrise?: string[];
    sunset?: string[];
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

async function fetchOpenMeteoPayload(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<{ payload: OpenMeteoPayload; via: 'direct' | 'proxy' }> {
  const directUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(5)}&longitude=${lng.toFixed(5)}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m,surface_pressure' +
    '&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,uv_index,is_day' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,uv_index_max,sunrise,sunset' +
    '&timezone=auto&forecast_days=7';

  try {
    const res = await fetch(directUrl, { signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = (await res.json()) as OpenMeteoPayload;
    if (payload?.current && payload?.hourly?.time?.length && payload?.daily?.time?.length) {
      return { payload, via: 'direct' };
    }
    throw new Error('Incomplete Open-Meteo payload');
  } catch (err) {
    if (signal?.aborted) throw err;
    const proxyPayload = await api<OpenMeteoPayload>(
      `/api/weather/forecast?lat=${encodeURIComponent(lat.toFixed(5))}&lng=${encodeURIComponent(lng.toFixed(5))}`,
      { signal, timeoutMs: 8000 },
    );
    if (!proxyPayload?.current || !proxyPayload?.hourly?.time?.length || !proxyPayload?.daily?.time?.length) {
      throw new Error('Weather forecast unavailable');
    }
    return { payload: proxyPayload, via: 'proxy' };
  }
}

export async function fetchDongNaiWeather(
  lat: number,
  lng: number,
  lang: 'vi' | 'en',
  signal?: AbortSignal,
): Promise<DongNaiWeather> {
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onParentAbort);
  const timer = setTimeout(() => ctrl.abort(), 10_000);

  try {
    const { payload: data, via } = await fetchOpenMeteoPayload(lat, lng, ctrl.signal);
    const cur = data.current!;
    const h = data.hourly!;
    const d = data.daily!;

    // Khớp đúng giờ địa phương tại tọa độ đang xem dựa theo `current.time` của Open-Meteo (không lệch múi giờ)
    const curHourPrefix = typeof cur.time === 'string' ? cur.time.slice(0, 13) : '';
    let startIdx = curHourPrefix ? h.time!.findIndex((t) => t.slice(0, 13) >= curHourPrefix) : 0;
    if (startIdx < 0) startIdx = 0;

    const hourly: HourlyPoint[] = h.time!.slice(startIdx, startIdx + 24).map((t, idx) => {
      const i = startIdx + idx;
      const pointIsDay = (h.is_day?.[i] ?? (idx === 0 ? cur.is_day : 1) ?? 1) === 1;
      const mapped = mapWmoCode(h.weather_code?.[i] ?? cur.weather_code ?? 0, pointIsDay);
      return {
        timeIso: t,
        hourLabel: idx === 0 ? (lang === 'vi' ? 'Bây giờ' : 'Now') : formatHourLabel(t),
        temp: round1(h.temperature_2m?.[i] ?? cur.temperature_2m ?? 0),
        rainProb: Math.round(h.precipitation_probability?.[i] ?? 0),
        rainMm: round1(h.precipitation?.[i] ?? 0),
        isDay: pointIsDay,
        kind: mapped.kind,
      };
    });

    const daily: DailyPoint[] = d.time!.slice(0, 7).map((dateIso, idx) => {
      const mapped = mapWmoCode(d.weather_code?.[idx] ?? 0, true);
      return {
        dateIso,
        dayLabel: formatDayLabel(dateIso, idx, lang),
        tempMin: round1(d.temperature_2m_min?.[idx] ?? 0),
        tempMax: round1(d.temperature_2m_max?.[idx] ?? 0),
        rainProbMax: Math.round(d.precipitation_probability_max?.[idx] ?? 0),
        rainSum: round1(d.precipitation_sum?.[idx] ?? 0),
        uvMax: Math.round(d.uv_index_max?.[idx] ?? 0),
        kind: mapped.kind,
        summaryVi: mapped.vi,
        summaryEn: mapped.en,
      };
    });

    const isDay = (cur.is_day ?? 1) === 1;
    const curMapped = mapWmoCode(cur.weather_code ?? 0, isDay);
    const uvNow = round1(h.uv_index?.[startIdx] ?? daily[0]?.uvMax ?? 0);
    const currentTemp = round1(cur.temperature_2m ?? hourly[0]?.temp ?? 0);

    return {
      source: 'live',
      providerLabel: via === 'direct' ? 'Open-Meteo Trực tiếp' : 'Open-Meteo (Máy chủ đồng bộ)',
      fetchedAt: new Date().toISOString(),
      observedAt: typeof cur.time === 'string' ? cur.time : new Date().toISOString(),
      timezone: data.timezone ?? 'Asia/Ho_Chi_Minh',
      lat: data.latitude ?? lat,
      lng: data.longitude ?? lng,
      temp: currentTemp,
      feelsLike: round1(cur.apparent_temperature ?? currentTemp),
      humidity: Math.round(cur.relative_humidity_2m ?? 0),
      windSpeed: Math.round(cur.wind_speed_10m ?? 0),
      windGusts: Math.round(cur.wind_gusts_10m ?? cur.wind_speed_10m ?? 0),
      pressureHpa: Math.round(cur.surface_pressure ?? 1013),
      rainNow: round1(cur.precipitation ?? cur.rain ?? 0),
      rainProbNow: hourly[0]?.rainProb ?? 0,
      cloudCover: Math.round(cur.cloud_cover ?? 0),
      uvIndex: isDay ? uvNow : 0,
      isDay,
      kind: curMapped.kind,
      conditionVi: curMapped.vi,
      conditionEn: curMapped.en,
      tempHigh: daily[0]?.tempMax ?? currentTemp,
      tempLow: daily[0]?.tempMin ?? currentTemp,
      sunrise: d.sunrise?.[0] ? formatHourLabel(d.sunrise[0]) : '--:--',
      sunset: d.sunset?.[0] ? formatHourLabel(d.sunset[0]) : '--:--',
      hourly,
      daily,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}
