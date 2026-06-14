/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
/// <reference types="vite-plugin-pwa/react" />

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export {};
