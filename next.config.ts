import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The simulation is pure typed-array math running in a Web Worker.
  // There is no server work, no database, and no external data.
  reactStrictMode: false,
};

export default nextConfig;
