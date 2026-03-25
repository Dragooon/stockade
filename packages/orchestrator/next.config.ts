import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // API-only app — no React pages needed
  serverExternalPackages: ['better-sqlite3', 'dockerode', 'ssh2', 'cpu-features'],
};

export default nextConfig;
