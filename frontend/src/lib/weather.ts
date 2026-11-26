import { inDongNaiBBox, resolveAdminUnit } from '@shared/geo';
import { apiUrl } from './api';
import type { PlaceSuggestion } from './geoClient';

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
  rainProbMaxToday: number;
  rainNext3hMm: number;
  rainSumTodayMm: number;
  cloudCover: number;
  uvIndex: number;
  uvMaxToday: number;
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

interface WeatherApiHour {
  time?: string;
  temp_c?: number;
  is_day?: number;
  condition?: { text?: string; code?: number };
  precip_mm?: number;
  chance_of_rain?: number;
}

interface WeatherApiForecastDay {
  date?: string;
  day?: {
    maxtemp_c?: number;
    mintemp_c?: number;
    totalprecip_mm?: number;
    daily_chance_of_rain?: number;
    uv?: number;
    condition?: { text?: string; code?: number };
  };
  astro?: {
    sunrise?: string;
    sunset?: string;
  };
  hour?: WeatherApiHour[];
}

interface WeatherApiPayload {
  location?: {
    lat?: number;
    lon?: number;
    tz_id?: string;
    localtime?: string;
  };
  current?: {
    last_updated?: string;
    temp_c?: number;
    feelslike_c?: number;
    is_day?: number;
    condition?: { text?: string; code?: number };
    wind_kph?: number;
    gust_kph?: number;
    pressure_mb?: number;
    precip_mm?: number;
    humidity?: number;
    cloud?: number;
    uv?: number;
  };
  forecast?: {
    forecastday?: WeatherApiForecastDay[];
  };
}

interface ProxyForecastEnvelope {
  provider?: 'weatherapi' | 'open-meteo';
  weatherApi?: WeatherApiPayload;
  openMeteo?: OpenMeteoPayload | null;
}

function getStoredWeatherApiKey(): string {
  const envKey = (import.meta.env?.VITE_WEATHERAPI_KEY as string | undefined)?.trim() ?? '';
  if (envKey) return envKey;
  try {
    return window.localStorage.getItem('weatherapi_key')?.trim() ?? '';
  } catch {
    return '';
  }
}

function mapWeatherApiCode(code: number): WeatherKind {
  if (code === 1000) return 'sun';
  if (code === 1003) return 'partlyCloudy';
  if (code === 1006 || code === 1009 || code === 1030 || code === 1135 || code === 1147) return 'cloud';
  if (code === 1087 || code === 1273 || code === 1276 || code === 1279 || code === 1282) return 'storm';
  if (code === 1192 || code === 1195 || code === 1243 || code === 1246) return 'heavyRain';
  if (code >= 1063) return 'rain';
  return 'partlyCloudy';
}

function to24hTime(raw?: string): string {
  if (!raw) return '--:--';
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(raw.trim());
  if (!m) return raw.slice(0, 5);
  let hh = Number(m[1]);
  const mm = m[2];
  const ampm = m[3]?.toUpperCase();
  if (ampm === 'PM' && hh < 12) hh += 12;
  if (ampm === 'AM' && hh === 12) hh = 0;
  return `${String(hh).padStart(2, '0')}:${mm}`;
}

function mapOpenMeteoDaily(data: OpenMeteoPayload, lang: 'vi' | 'en'): DailyPoint[] {
  const d = data.daily;
  if (!d?.time?.length) return [];
  return d.time.slice(0, 7).map((dateIso, idx) => {
    const mapped = mapWmoCode(d.weather_code?.[idx] ?? 0, true);
    return {
      dateIso,
      dayLabel: formatDayLabel(dateIso, idx, lang),
      tempMin: Math.round(d.temperature_2m_min?.[idx] ?? 0),
      tempMax: Math.round(d.temperature_2m_max?.[idx] ?? 0),
      rainProbMax: Math.round(d.precipitation_probability_max?.[idx] ?? 0),
      rainSum: round1(d.precipitation_sum?.[idx] ?? 0),
      uvMax: Math.round(d.uv_index_max?.[idx] ?? 0),
      kind: mapped.kind,
      summaryVi: mapped.vi,
      summaryEn: mapped.en,
    };
  });
}

function mapWeatherApiToDongNaiWeather(
  wapi: WeatherApiPayload,
  openMeteoFallback: OpenMeteoPayload | null | undefined,
  lat: number,
  lng: number,
  lang: 'vi' | 'en',
): DongNaiWeather {
  const cur = wapi.current!;
  const days = wapi.forecast?.forecastday ?? [];
  const today = days[0];
  const localTime = wapi.location?.localtime ?? cur.last_updated ?? '';
  const curHourKey = localTime.length >= 13 ? `${localTime.slice(0, 13)}:00` : '';

  const allHours = days.slice(0, 2).flatMap((d) => d.hour ?? []);
  let startIdx = curHourKey ? allHours.findIndex((hr) => (hr.time ?? '') === curHourKey) : -1;
  if (startIdx < 0 && curHourKey) {
    for (let i = allHours.length - 1; i >= 0; i--) {
      if ((allHours[i].time ?? '') <= curHourKey) {
        startIdx = i;
        break;
      }
    }
  }
  if (startIdx < 0) startIdx = 0;

  const hourly: HourlyPoint[] = allHours.slice(startIdx, startIdx + 24).map((hr, idx) => {
    const t = hr.time ?? '';
    const hourPart = t.slice(11, 16) || '--:--';
    return {
      timeIso: t.replace(' ', 'T'),
      hourLabel: idx === 0 ? (lang === 'vi' ? 'Bây giờ' : 'Now') : hourPart,
      temp: Math.round(hr.temp_c ?? cur.temp_c ?? 0),
      rainProb: Math.round(hr.chance_of_rain ?? 0),
      rainMm: round1(hr.precip_mm ?? 0),
      isDay: (hr.is_day ?? 1) === 1,
      kind: mapWeatherApiCode(hr.condition?.code ?? 1003),
    };
  });

  let daily: DailyPoint[] = days.slice(0, 7).map((fd, idx) => {
    const dateIso = fd.date ?? '';
    const condText = fd.day?.condition?.text?.trim() || 'Mây thay đổi';
    return {
      dateIso,
      dayLabel: formatDayLabel(dateIso, idx, lang),
      tempMin: Math.round(fd.day?.mintemp_c ?? 0),
      tempMax: Math.round(fd.day?.maxtemp_c ?? 0),
      rainProbMax: Math.round(fd.day?.daily_chance_of_rain ?? 0),
      rainSum: round1(fd.day?.totalprecip_mm ?? 0),
      uvMax: Math.round(fd.day?.uv ?? 0),
      kind: mapWeatherApiCode(fd.day?.condition?.code ?? 1003),
      summaryVi: condText,
      summaryEn: condText,
    };
  });

  if (daily.length < 7 && openMeteoFallback) {
    const omDaily = mapOpenMeteoDaily(openMeteoFallback, lang);
    const seen = new Set(daily.map((d) => d.dateIso));
    for (const item of omDaily) {
      if (!seen.has(item.dateIso)) {
        daily.push({
          ...item,
          dayLabel: formatDayLabel(item.dateIso, daily.length, lang),
        });
        seen.add(item.dateIso);
      }
      if (daily.length >= 7) break;
    }
  }

  const currentHour = allHours[startIdx];
  const rainNow = round1(cur.precip_mm ?? 0);
  const rainProbNow = Math.round(currentHour?.chance_of_rain ?? today?.day?.daily_chance_of_rain ?? 0);
  const rainProbMaxToday = Math.round(today?.day?.daily_chance_of_rain ?? rainProbNow);
  const rainNext3hMm = round1(
    [0, 1, 2].reduce((sum, offset) => sum + (allHours[startIdx + offset]?.precip_mm ?? 0), 0),
  );
  const rainSumTodayMm = round1(today?.day?.totalprecip_mm ?? rainNext3hMm);
  const currentTemp = Math.round(cur.temp_c ?? 0);
  const uvNow = round1(cur.uv ?? 0);
  const uvMaxToday = round1(today?.day?.uv ?? uvNow);
  const condText = cur.condition?.text?.trim() || 'Mây thay đổi';

  return {
    source: 'live',
    providerLabel: 'Trạm khí tượng trực tiếp',
    fetchedAt: new Date().toISOString(),
    observedAt: (cur.last_updated ?? localTime ?? new Date().toISOString()).replace(' ', 'T'),
    timezone: wapi.location?.tz_id ?? 'Asia/Ho_Chi_Minh',
    lat: wapi.location?.lat ?? lat,
    lng: wapi.location?.lon ?? lng,
    temp: currentTemp,
    feelsLike: Math.round(cur.feelslike_c ?? currentTemp),
    humidity: Math.round(cur.humidity ?? 0),
    windSpeed: Math.round(cur.wind_kph ?? 0),
    windGusts: Math.round(cur.gust_kph ?? cur.wind_kph ?? 0),
    pressureHpa: Math.round(cur.pressure_mb ?? 1013),
    rainNow,
    rainProbNow,
    rainProbMaxToday,
    rainNext3hMm,
    rainSumTodayMm,
    cloudCover: Math.round(cur.cloud ?? 0),
    uvIndex: uvNow,
    uvMaxToday,
    isDay: (cur.is_day ?? 1) === 1,
    kind: mapWeatherApiCode(cur.condition?.code ?? 1003),
    conditionVi: condText,
    conditionEn: condText,
    tempHigh: daily[0]?.tempMax ?? currentTemp,
    tempLow: daily[0]?.tempMin ?? currentTemp,
    sunrise: to24hTime(today?.astro?.sunrise),
    sunset: to24hTime(today?.astro?.sunset),
    hourly,
    daily,
  };
}

async function fetchOpenMeteoDirect(
  lat: number,
  lng: number,
  signal?: AbortSignal,
): Promise<OpenMeteoPayload> {
  const directUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(5)}&longitude=${lng.toFixed(5)}` +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_gusts_10m' +
    '&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,rain,uv_index,weather_code,is_day' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max' +
    '&timezone=auto&forecast_days=7';

  const res = await fetch(directUrl, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = (await res.json()) as OpenMeteoPayload;
  if (payload?.current && payload?.hourly?.time?.length && payload?.daily?.time?.length) {
    return payload;
  }
  throw new Error('Incomplete Open-Meteo payload');
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
    const clientWapiKey = getStoredWeatherApiKey();

    // 1. Ưu tiên gọi Backend Proxy (/api/weather/forecast) — server dùng process.env.WEATHERAPI_KEY hoặc header X-Weather-Api-Key
    try {
      const proxyPath = apiUrl(`/api/weather/forecast?lat=${encodeURIComponent(lat.toFixed(5))}&lng=${encodeURIComponent(lng.toFixed(5))}&lang=${lang}`);
      const proxyRes = await fetch(proxyPath, {
        signal: ctrl.signal,
        headers: clientWapiKey ? { 'X-Weather-Api-Key': clientWapiKey } : undefined,
      });
      if (proxyRes.ok && (proxyRes.headers.get('content-type') ?? '').includes('application/json')) {
        const envPayload = (await proxyRes.json()) as ProxyForecastEnvelope & OpenMeteoPayload;
        if (envPayload.provider === 'weatherapi' && envPayload.weatherApi?.current && envPayload.weatherApi?.forecast?.forecastday?.length) {
          return mapWeatherApiToDongNaiWeather(envPayload.weatherApi, envPayload.openMeteo, lat, lng, lang);
        }
        if (envPayload?.current && envPayload?.hourly?.time?.length && envPayload?.daily?.time?.length) {
          return mapOpenMeteoToDongNaiWeather(envPayload, 'proxy', lat, lng, lang);
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) throw err;
    }

    // 2. Nếu deploy tĩnh hoặc proxy chưa có key nhưng client có VITE_WEATHERAPI_KEY / localStorage, gọi WeatherAPI.com trực tiếp
    if (clientWapiKey) {
      try {
        const wapiUrl =
          `https://api.weatherapi.com/v1/forecast.json?key=${encodeURIComponent(clientWapiKey)}` +
          `&q=${lat.toFixed(5)},${lng.toFixed(5)}&days=7&aqi=yes&alerts=yes&lang=${lang}`;
        const [wapiRes, omRes] = await Promise.allSettled([
          fetch(wapiUrl, { signal: ctrl.signal, cache: 'no-store' }),
          fetchOpenMeteoDirect(lat, lng, ctrl.signal),
        ]);
        if (wapiRes.status === 'fulfilled' && wapiRes.value.ok) {
          const wapiJson = (await wapiRes.value.json()) as WeatherApiPayload;
          if (wapiJson?.current && wapiJson?.forecast?.forecastday?.length) {
            const omFallback = omRes.status === 'fulfilled' ? omRes.value : null;
            return mapWeatherApiToDongNaiWeather(wapiJson, omFallback, lat, lng, lang);
          }
        }
      } catch (err) {
        if (ctrl.signal.aborted) throw err;
      }
    }

    // 3. Fallback an toàn sang Open-Meteo
    const omDirect = await fetchOpenMeteoDirect(lat, lng, ctrl.signal);
    return mapOpenMeteoToDongNaiWeather(omDirect, 'direct', lat, lng, lang);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

function mapOpenMeteoToDongNaiWeather(
  data: OpenMeteoPayload,
  via: 'direct' | 'proxy',
  lat: number,
  lng: number,
  lang: 'vi' | 'en',
): DongNaiWeather {
  const cur = data.current!;
  const h = data.hourly!;
  const d = data.daily!;

  // Khớp đúng chỉ số khung giờ hiện tại (`YYYY-MM-DDTHH:00`) từ `data.current.time`
  const curHourIso =
    typeof cur.time === 'string' && cur.time.length >= 13 ? `${cur.time.slice(0, 13)}:00` : '';
  let startIdx = curHourIso ? h.time!.findIndex((t) => t === curHourIso) : -1;
  if (startIdx < 0 && curHourIso) {
    for (let i = h.time!.length - 1; i >= 0; i--) {
      if (h.time![i] <= curHourIso) {
        startIdx = i;
        break;
      }
    }
  }
  if (startIdx < 0) startIdx = 0;

  const hourly: HourlyPoint[] = h.time!.slice(startIdx, startIdx + 24).map((t, idx) => {
    const i = startIdx + idx;
    const pointIsDay = (h.is_day?.[i] ?? (idx === 0 ? cur.is_day : 1) ?? 1) === 1;
    const mapped = mapWmoCode(h.weather_code?.[i] ?? cur.weather_code ?? 0, pointIsDay);
    return {
      timeIso: t,
      hourLabel: idx === 0 ? (lang === 'vi' ? 'Bây giờ' : 'Now') : formatHourLabel(t),
      temp: Math.round(h.temperature_2m?.[i] ?? cur.temperature_2m ?? 0),
      rainProb: Math.round(h.precipitation_probability?.[i] ?? 0),
      rainMm: round1(h.precipitation?.[i] ?? 0),
      isDay: pointIsDay,
      kind: mapped.kind,
    };
  });

  const daily = mapOpenMeteoDaily(data, lang);

  const isDay = (cur.is_day ?? 1) === 1;
  const curMapped = mapWmoCode(cur.weather_code ?? 0, isDay);
  const uvNow = round1(h.uv_index?.[startIdx] ?? 0);
  const uvMaxToday = round1(d.uv_index_max?.[0] ?? uvNow);
  const rainNow = round1(cur.precipitation ?? cur.rain ?? 0);
  const rainProbNow = Math.round(h.precipitation_probability?.[startIdx] ?? 0);
  const rainProbMaxToday = Math.round(d.precipitation_probability_max?.[0] ?? rainProbNow);
  const rainNext3hMm = round1(
    [0, 1, 2].reduce((sum, offset) => sum + (h.precipitation?.[startIdx + offset] ?? 0), 0),
  );
  const rainSumTodayMm = round1(d.precipitation_sum?.[0] ?? rainNext3hMm);
  const currentTemp = Math.round(cur.temperature_2m ?? hourly[0]?.temp ?? 0);

  return {
    source: 'live',
    providerLabel: via === 'direct' ? 'Open-Meteo Trực tiếp' : 'Open-Meteo (Máy chủ đồng bộ)',
    fetchedAt: new Date().toISOString(),
    observedAt: typeof cur.time === 'string' ? cur.time : new Date().toISOString(),
    timezone: data.timezone ?? 'Asia/Ho_Chi_Minh',
    lat: data.latitude ?? lat,
    lng: data.longitude ?? lng,
    temp: currentTemp,
    feelsLike: Math.round(cur.apparent_temperature ?? currentTemp),
    humidity: Math.round(cur.relative_humidity_2m ?? 0),
    windSpeed: Math.round(cur.wind_speed_10m ?? 0),
    windGusts: Math.round(cur.wind_gusts_10m ?? cur.wind_speed_10m ?? 0),
    pressureHpa: Math.round(cur.surface_pressure ?? 1013),
    rainNow,
    rainProbNow,
    rainProbMaxToday,
    rainNext3hMm,
    rainSumTodayMm,
    cloudCover: Math.round(cur.cloud_cover ?? 0),
    uvIndex: uvNow,
    uvMaxToday,
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
}

interface OpenMeteoGeocodingPayload {
  results?: Array<{
    id?: number;
    name?: string;
    latitude?: number;
    longitude?: number;
    admin1?: string;
    admin2?: string;
    country?: string;
  }>;
}

/** Tìm tọa độ chính xác tỉnh/thành phố, quận/huyện, địa danh qua Open-Meteo Geocoding API. */
export async function searchOpenMeteoLocations(
  query: string,
  lang: 'vi' | 'en',
  signal?: AbortSignal,
): Promise<PlaceSuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=${lang}&format=json`;
    const res = await fetch(url, { signal, cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as OpenMeteoGeocodingPayload;
    const out: PlaceSuggestion[] = [];
    for (const r of data.results ?? []) {
      if (typeof r.latitude !== 'number' || typeof r.longitude !== 'number' || !r.name) continue;
      const wardCode = inDongNaiBBox(r.latitude, r.longitude)
        ? resolveAdminUnit({ lat: r.latitude, lng: r.longitude, rawAddressText: [r.name, r.admin2, r.admin1].filter(Boolean).join(', ') }).wardCode ?? undefined
        : undefined;
      const sub = [r.admin2, r.admin1, r.country].filter(Boolean).join(' · ');
      out.push({
        id: `omgeo:${r.id ?? out.length}:${r.latitude.toFixed(4)}:${r.longitude.toFixed(4)}`,
        label: r.name,
        sublabel: sub || `${r.latitude.toFixed(3)}, ${r.longitude.toFixed(3)}`,
        kind: 'place',
        lat: r.latitude,
        lng: r.longitude,
        wardCode,
      });
    }
    return out;
  } catch {
    return [];
  }
}
