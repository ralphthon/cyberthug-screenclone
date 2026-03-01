import type { Config } from 'tailwindcss';

const withAlpha = (cssVariable: string): string => `rgb(var(${cssVariable}) / <alpha-value>)`;

const config: Config = {
  darkMode: 'class',
  content: ['./src/client/index.html', './src/client/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: withAlpha('--color-primary'),
        surface: withAlpha('--color-surface'),
        card: withAlpha('--color-card'),
        slate: {
          50: withAlpha('--color-slate-50'),
          100: withAlpha('--color-slate-100'),
          200: withAlpha('--color-slate-200'),
          300: withAlpha('--color-slate-300'),
          400: withAlpha('--color-slate-400'),
          500: withAlpha('--color-slate-500'),
          600: withAlpha('--color-slate-600'),
          700: withAlpha('--color-slate-700'),
          800: withAlpha('--color-slate-800'),
          900: withAlpha('--color-slate-900'),
        },
      },
    },
  },
  plugins: [],
};

export default config;
