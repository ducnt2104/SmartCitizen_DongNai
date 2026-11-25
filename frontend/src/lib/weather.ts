export type WeatherKind = 'sun' | 'partlyCloudy' | 'cloud' | 'rain' | 'heavyRain' | 'storm';

export interface HourlyPoint {
  timeIso: string;
  hourLabel: string;
  temp: number;
  rainProb: number;
  rainMm: number;
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
  source: 'live' | 'fallback';
  fetchedAt: string;
  lat: number;
  lng: number;
  temp: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
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
  hourly: HourlyPoint[];
  daily: DailyPoint[];
}

function mapWmoCode(code: number): { kind: WeatherKind; vi: string; en: string } {
  if (code === 0) return { kind: 'sun', vi: 'Trời quang, nắng ráo', en: 'Clear & sunny' };
  if (code <= 2) return { kind: 'partlyCloudy', vi: 'Ít mây, nắng nhẹ', en: 'Partly cloudy' };
  if (code === 3 || code === 45 || code === 48) return { kind: 'cloud', vi: 'Nhiều mây, âm u', en: 'Cloudy & overcast' };
  if ((code >= 51 && code <= 63) || (code >= 80 && code <= 81)) {
    return { kind: 'rain', vi: 'Có mưa rào rải rác', en: 'Scattered showers' };
  }
  if (code === 65 || code === 67 || code === 82) {
    return { kind: 'heavyRain', vi: 'Mưa vừa đến mưa to', en: 'Moderate to heavy rain' };
  }
  if (code >= 95) {
    return { kind: 'storm', vi: 'Mưa dông, có khả năng gió giật', en: 'Thunderstorm & gusty winds' };
  }
  return { kind: 'partlyCloudy', vi: 'Mây thay đổi', en: 'Variable clouds' };
}

function formatHour(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(11, 16);
  return `${String(d.getHours()).padStart(2, '0')}:00`;
}

function formatDay(iso: string, idx: number, lang: 'vi' | 'en'): string {
  if (idx === 0) return lang === 'vi' ? 'Hôm nay' : 'Today';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-US', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

export function buildFallbackWeather(lat: number, lng: number, lang: 'vi' | 'en'): DongNaiWeather {
  const now = new Date();
  const baseHour = now.getHours();
  const hourly: HourlyPoint[] = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getTime() + i * 3600_000);
    const h = d.getHours();
    const isAfternoon = h >= 13 && h <= 18;
    return {
      timeIso: d.toISOString(),
      hourLabel: i === 0 ? (lang === 'vi' ? 'Bây giờ' : 'Now') : `${String(h).padStart(2, '0')}:00`,
      temp: isAfternoon ? 32 - Math.abs(h - 15) : h >= 6 && h < 13 ? 27 + Math.round((h - 6) * 0.8) : 25,
      rainProb: isAfternoon ? 65 : h >= 19 && h <= 22 ? 40 : 20,
      rainMm: isAfternoon ? 3.2 : 0.4,
      kind: isAfternoon ? 'rain' : h >= 6 && h <= 17 ? 'partlyCloudy' : 'cloud',
    };
  });

  const daily: DailyPoint[] = [
    { tempMin: 24, tempMax: 33, rainProbMax: 65, rainSum: 8.4, uvMax: 8, code: 80 },
    { tempMin: 24, tempMax: 32, rainProbMax: 75, rainSum: 14.2, uvMax: 7, code: 63 },
    { tempMin: 23, tempMax: 31, rainProbMax: 80, rainSum: 22.5, uvMax: 6, code: 95 },
    { tempMin: 24, tempMax: 33, rainProbMax: 45, rainSum: 3.1, uvMax: 9, code: 2 },
    { tempMin: 25, tempMax: 34, rainProbMax: 30, rainSum: 1.0, uvMax: 9, code: 1 },
  ].map((row, idx) => {
    const d = new Date(now.getTime() + idx * 86400_000);
    const dateIso = d.toISOString().slice(0, 10);
    const mapped = mapWmoCode(row.code);
    return {
      dateIso,
      dayLabel: formatDay(dateIso, idx, lang),
      tempMin: row.tempMin,
      tempMax: row.tempMax,
      rainProbMax: row.rainProbMax,
      rainSum: row.rainSum,
      uvMax: row.uvMax,
      kind: mapped.kind,
      summaryVi: mapped.vi,
      summaryEn: mapped.en,
    };
  });

  const isDay = baseHour >= 6 && baseHour < 18;
  return {
    source: 'fallback',
    fetchedAt: now.toISOString(),
    lat,
    lng,
    temp: hourly[0].temp,
    feelsLike: hourly[0].temp + 3,
    humidity: 78,
    windSpeed: 14,
    rainNow: 0.8,
    rainProbNow: hourly[0].rainProb,
    cloudCover: 62,
    uvIndex: isDay ? 7 : 0,
    isDay,
    kind: hourly[0].kind,
    conditionVi: 'Mây thay đổi, chiều tối có mưa rào',
    conditionEn: 'Partly cloudy with evening showers',
    tempHigh: 33,
    tempLow: 24,
    hourly,
    daily,
  };
}

interface OpenMeteoPayload {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    apparent_temperature?: number;
    is_day?: number;
    precipitation?: number;
    weather_code?: number;
    cloud_cover?: number;
    wind_speed_10m?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    precipitation_probability?: number[];
    precipitation?: number[];
    weather_code?: number[];
    uv_index?: number[];
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
    precipitation_probability_max?: number[];
    uv_index_max?: number[];
  };
}

export async function fetchDongNaiWeather(lat: number, lng: number, lang: 'vi' | 'en'): Promise<DongNaiWeather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,wind_speed_10m' +
    '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,uv_index' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,uv_index_max' +
    '&timezone=Asia%2FHo_Chi_Minh&forecast_days=5';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6500);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as OpenMeteoPayload;
    const cur = data.current;
    const h = data.hourly;
    const d = data.daily;
    if (!cur || !h?.time?.length || !d?.time?.length) throw new Error('Incomplete weather payload');

    const nowMs = Date.now();
    let startIdx = h.time.findIndex((t) => new Date(t).getTime() >= nowMs - 1800_000);
    if (startIdx < 0) startIdx = 0;

    const hourly: HourlyPoint[] = h.time.slice(startIdx, startIdx + 12).map((t, idx) => {
      const i = startIdx + idx;
      const mapped = mapWmoCode(h.weather_code?.[i] ?? 2);
      return {
        timeIso: t,
        hourLabel: idx === 0 ? (lang === 'vi' ? 'Bây giờ' : 'Now') : formatHour(t),
        temp: Math.round(h.temperature_2m?.[i] ?? cur.temperature_2m ?? 30),
        rainProb: Math.round(h.precipitation_probability?.[i] ?? 0),
        rainMm: Number((h.precipitation?.[i] ?? 0).toFixed(1)),
        kind: mapped.kind,
      };
    });

    const daily: DailyPoint[] = d.time.slice(0, 5).map((dateIso, idx) => {
      const mapped = mapWmoCode(d.weather_code?.[idx] ?? 2);
      return {
        dateIso,
        dayLabel: formatDay(dateIso, idx, lang),
        tempMin: Math.round(d.temperature_2m_min?.[idx] ?? 24),
        tempMax: Math.round(d.temperature_2m_max?.[idx] ?? 33),
        rainProbMax: Math.round(d.precipitation_probability_max?.[idx] ?? 0),
        rainSum: Number((d.precipitation_sum?.[idx] ?? 0).toFixed(1)),
        uvMax: Math.round(d.uv_index_max?.[idx] ?? 7),
        kind: mapped.kind,
        summaryVi: mapped.vi,
        summaryEn: mapped.en,
      };
    });

    const curMapped = mapWmoCode(cur.weather_code ?? 2);
    const uvNow = Math.round(h.uv_index?.[startIdx] ?? daily[0]?.uvMax ?? 5);

    return {
      source: 'live',
      fetchedAt: new Date().toISOString(),
      lat,
      lng,
      temp: Math.round(cur.temperature_2m ?? 30),
      feelsLike: Math.round(cur.apparent_temperature ?? cur.temperature_2m ?? 32),
      humidity: Math.round(cur.relative_humidity_2m ?? 75),
      windSpeed: Math.round(cur.wind_speed_10m ?? 10),
      rainNow: Number((cur.precipitation ?? 0).toFixed(1)),
      rainProbNow: hourly[0]?.rainProb ?? 0,
      cloudCover: Math.round(cur.cloud_cover ?? 45),
      uvIndex: (cur.is_day ?? 1) ? uvNow : 0,
      isDay: Boolean(cur.is_day ?? 1),
      kind: curMapped.kind,
      conditionVi: curMapped.vi,
      conditionEn: curMapped.en,
      tempHigh: daily[0]?.tempMax ?? 33,
      tempLow: daily[0]?.tempMin ?? 24,
      hourly,
      daily,
    };
  } catch {
    return buildFallbackWeather(lat, lng, lang);
  } finally {
    clearTimeout(timer);
  }
}
