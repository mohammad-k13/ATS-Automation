import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    // keep these as plain Node modules on the server
    serverExternalPackages: ['pdf-parse', 'mammoth', 'undici', '@anthropic-ai/sdk'],
    devIndicators: false,
};

export default nextConfig;
