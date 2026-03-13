export default {
  test: {
    globals: true,
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    exclude: ['packages/control-plane/src/__tests__/integration.test.ts'],
  },
};
