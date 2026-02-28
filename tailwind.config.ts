import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  content: ['./src/client/index.html', './src/client/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#6366f1',
        surface: '#1e1b2e',
        card: '#2a2740',
      },
    },
  },
  plugins: [],
} satisfies Config;
