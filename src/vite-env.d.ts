/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export {};
