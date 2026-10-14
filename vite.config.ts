import { defineConfig } from 'vite';
export default defineConfig(({ mode }) => ({
  base: mode === 'pages' ? '/bonito-lane/' : '/',
  build: {
    sourcemap: false,
    rollupOptions: {
      input: 'index.html',
      output: {
        manualChunks: {
          'physics-wasm': ['@dimforge/rapier3d-compat'],
          'graphics': ['three/webgpu', 'three/addons/loaders/GLTFLoader.js'],
        },
      },
    },
  },
}));
