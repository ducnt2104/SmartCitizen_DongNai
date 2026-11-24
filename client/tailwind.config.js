/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: token('bg'),
        surface: token('surface'),
        'surface-2': token('surface-2'),
        ink: token('ink'),
        muted: token('muted'),
        line: token('line'),
        brand: token('brand'),
        'brand-ink': token('brand-ink'),
        'brand-soft': token('brand-soft'),
        accent: token('accent'),
        danger: token('danger'),
        'danger-soft': token('danger-soft'),
        ok: token('ok'),
        'ok-soft': token('ok-soft'),
        warn: token('warn'),
        'warn-soft': token('warn-soft'),
        // Cổng IOC (Command Center)
        ioc: {
          bg: '#0B1120',
          panel: '#0F172A',
          raised: '#131C31',
          line: '#1E293B',
          text: '#E2E8F0',
          dim: '#94A3B8',
          cyan: '#22D3EE',
          amber: '#FBBF24',
          red: '#F87171',
          green: '#4ADE80',
        },
      },
      fontFamily: {
        sans: ['"Be Vietnam Pro"', 'system-ui', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgb(15 23 42 / 0.06), 0 4px 14px rgb(15 23 42 / 0.05)',
        lift: '0 8px 24px rgb(15 23 42 / 0.12)',
      },
      keyframes: {
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        pop: { from: { opacity: '0', transform: 'scale(0.95)' }, to: { opacity: '1', transform: 'scale(1)' } },
        slideup: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        pulseRing: { '0%': { boxShadow: '0 0 0 0 rgb(239 68 68 / 0.55)' }, '100%': { boxShadow: '0 0 0 14px rgb(239 68 68 / 0)' } },
      },
      animation: {
        shimmer: 'shimmer 1.4s infinite',
        pop: 'pop 180ms cubic-bezier(0.23, 1, 0.32, 1)',
        slideup: 'slideup 220ms cubic-bezier(0.23, 1, 0.32, 1)',
        ring: 'pulseRing 1.6s infinite',
      },
    },
  },
  plugins: [],
};
