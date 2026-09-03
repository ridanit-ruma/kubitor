import type { NextConfig } from 'next';

const config: NextConfig = {
  // The image runs the server output directly; nothing is exported statically.
  output: 'standalone',
  reactStrictMode: true,
  // The API and the dashboard are served from one origin behind the ingress, so
  // the browser sends its session cookie without any CORS arrangement.
  async rewrites() {
    const server = process.env.KUBITOR_SERVER_ORIGIN;
    return server ? [{ source: '/api/:path*', destination: `${server}/api/:path*` }] : [];
  },
};

export default config;
