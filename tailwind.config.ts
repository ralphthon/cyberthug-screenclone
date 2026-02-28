import type { Config } from 'tailwindcss';

const config: Config = {
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
};

export default config;
