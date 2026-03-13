function enableNodeProxyFromEnv() {
  const hasProxy = Boolean(
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  );

  if (hasProxy && process.env.NODE_USE_ENV_PROXY === undefined) {
    process.env.NODE_USE_ENV_PROXY = '1';
  }
}

async function main() {
  enableNodeProxyFromEnv();
  const { startControlPlane } = await import('./server.js');
  await startControlPlane();
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
