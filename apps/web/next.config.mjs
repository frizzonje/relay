/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @relay/shared отдаётся как TS-исходник — Next компилирует его сам.
  transpilePackages: ['@relay/shared'],
  // Минимальный runtime для прод-образа.
  output: 'standalone',
};

export default nextConfig;
